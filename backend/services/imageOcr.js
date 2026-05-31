import {
  parseBestNutritionBlock,
  extractBarcodeFromText,
  extractIngredientsFromOcr,
  normalizeOcrText,
} from '../scoring/nutritionParse.js';
import {
  collectAllNutritionBlocks,
  dedupeNutritionBlocks,
  parseVariantBlocks,
} from '../scoring/variantParse.js';

const NUTRITION_ALT_RE =
  /nutrition|ingredient|label|facts|back\s*of|pack|barcode|composition|allergen|per\s*100/i;

const MAX_IMAGES = 10;

const FLAVOUR_ALT_RE = /cranberr|fruit\s*(?:&|and)\s*nut|intense|70\s*%?\s*dark|bournville/i;

/**
 * Prefer full-resolution Amazon gallery URLs for OCR.
 * @param {string} url
 */
function upgradeAmazonImageUrl(url) {
  if (!url) return url;
  let u = url
    .replace(/\._AC_[A-Z0-9_]+_\./, '._AC_SL1500_.')
    .replace(/\._SX\d+_\./, '._SL1500_.')
    .replace(/\._SY\d+_\./, '._SL1500_.')
    .replace(/\._SL\d+_\./, '._SL1500_.');
  if (/\.webp(\?|$)/i.test(u)) u = u.replace(/\.webp(\?.*)?$/i, '.jpg$1');
  return u;
}

/**
 * @param {Buffer} buf
 * @param {string} [contentType]
 */
function isSupportedOcrImage(buf, contentType = '') {
  if (!buf || buf.length < 100) return false;
  if (looksLikeHtml(buf)) return false;

  const ct = contentType.toLowerCase();
  if (ct.includes('webp')) return false;
  if (ct.includes('svg') || ct.includes('text/html')) return false;

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;

  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return false;

  if (ct.includes('image/jpeg') || ct.includes('image/jpg') || ct.includes('image/png')) {
    return true;
  }

  return false;
}

/**
 * @param {Buffer} buf
 */
function looksLikeHtml(buf) {
  const sample = buf.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  return sample.startsWith('<!doctype') || sample.startsWith('<html') || sample.startsWith('<');
}

/**
 * @param {import('tesseract.js').Worker} worker
 * @param {Buffer} buffer
 * @param {string} url
 */
async function recognizeBufferSafe(worker, buffer, url) {
  try {
    const result = await worker.recognize(buffer);
    return result?.data?.text || '';
  } catch (e) {
    console.warn('[EcoHealth] OCR skip (unreadable image):', url.slice(0, 100), e.message || e);
    return '';
  }
}

/**
 * @param {import('tesseract.js').Worker} worker
 * @param {Buffer} buffer
 * @param {string} url
 */
async function recognizeWithFallback(worker, buffer, url) {
  let text = await recognizeBufferSafe(worker, buffer, url);
  if (text.trim().length >= 80) return text;

  try {
    await worker.setParameters({ tessedit_pageseg_mode: '3' });
    const alt = await recognizeBufferSafe(worker, buffer, url);
    if (alt.trim().length > text.trim().length) text = alt;
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
  }
  return text;
}

/**
 * @param {Array<{ url: string, alt?: string }>} images
 * @returns {Promise<{ text: string, nutrition: object | null, barcode: string | null, ingredientsText: string, sources: string[], variants?: object[] } | null>}
 */
export async function extractFromProductImages(images) {
  if (!images?.length) return null;

  const ranked = [...images]
    .filter((img) => img?.url?.startsWith('http'))
    .map((img) => ({ ...img, url: upgradeAmazonImageUrl(img.url) }))
    .sort((a, b) => scoreImage(b) - scoreImage(a))
    .slice(0, MAX_IMAGES);

  if (!ranked.length) return null;

  let createWorker;
  try {
    ({ createWorker } = await import('tesseract.js'));
  } catch {
    console.warn('[EcoHealth] tesseract.js not installed — run npm install in backend/');
    return extractFromImageAltsOnly(ranked);
  }

  let worker;
  try {
    worker = await createWorker('eng');
    await worker.setParameters({ tessedit_pageseg_mode: '6' });

    let combinedText = '';
    let bestNutrition = null;
    let bestCount = 0;
    let barcode = null;
    let ingredientsText = '';
    /** @type {Array<object>} */
    const perImageBlocks = [];
    let ocrAttempts = 0;
    let ocrSuccess = 0;

    for (const img of ranked) {
      const altText = (img.alt || '').trim();
      if (altText.length > 20) combinedText += '\n' + altText;

      const fetched = await fetchImageBuffer(img.url);
      if (!fetched) continue;

      const { buffer, contentType } = fetched;
      if (!isSupportedOcrImage(buffer, contentType)) {
        console.warn(
          '[EcoHealth] OCR skip (unsupported format):',
          img.url.slice(0, 100),
          contentType || 'unknown'
        );
        continue;
      }

      ocrAttempts += 1;
      const rawText = await recognizeWithFallback(worker, buffer, img.url);
      if (!rawText?.trim()) continue;

      ocrSuccess += 1;
      const text = normalizeOcrText(rawText);
      combinedText += '\n' + text;

      const blocks = collectAllNutritionBlocks(text);
      for (const b of blocks) {
        perImageBlocks.push(b);
      }

      if (dedupeNutritionBlocks(perImageBlocks).length >= 3) break;

      const nutrition = parseBestNutritionBlock(text);
      if (nutrition) {
        const count = Object.keys(nutrition).filter((k) => k !== 'per').length;
        if (count > bestCount) {
          bestCount = count;
          bestNutrition = nutrition;
        }
      }

      if (!barcode) barcode = extractBarcodeFromText(text);
      if (!ingredientsText || ingredientsText.length < 40) {
        const ing = extractIngredientsFromOcr(text);
        if (ing.length > ingredientsText.length) ingredientsText = ing;
      }
    }

    if (ocrAttempts > 0 && ocrSuccess === 0) {
      console.warn('[EcoHealth] OCR: no images could be read — using alt text only');
      return extractFromImageAltsOnly(ranked);
    }

    if (!combinedText.trim()) return extractFromImageAltsOnly(ranked);

    let variantBlocks = dedupeNutritionBlocks(perImageBlocks);
    if (variantBlocks.length < 2) {
      variantBlocks = dedupeNutritionBlocks([
        ...variantBlocks,
        ...collectAllNutritionBlocks(combinedText),
        ...parseVariantBlocks(combinedText),
      ]);
    }

    const barcodes = new Set();
    for (const b of variantBlocks) {
      if (b.barcode) barcodes.add(b.barcode);
    }
    if (!barcode && barcodes.size === 1) barcode = [...barcodes][0];

    return {
      text: combinedText,
      nutrition: bestNutrition,
      barcode,
      ingredientsText,
      variants: variantBlocks.length >= 2 ? variantBlocks : undefined,
      sources: ocrSuccess > 0 ? ['product_image_ocr'] : ['product_image_alt'],
    };
  } catch (e) {
    console.warn('[EcoHealth] OCR pipeline failed:', e.message || e);
    return extractFromImageAltsOnly(ranked);
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * @param {{ url: string, alt?: string }} img
 */
function scoreImage(img) {
  let s = 0;
  const alt = (img.alt || '').toLowerCase();
  const url = (img.url || '').toLowerCase();
  if (NUTRITION_ALT_RE.test(alt)) s += 10;
  if (FLAVOUR_ALT_RE.test(alt)) s += 8;
  const flavourHits = [
    /cranberr/,
    /fruit\s*(?:&|and)\s*nut/,
    /intense|70\s*%?\s*dark/,
  ].filter((re) => re.test(alt)).length;
  if (flavourHits >= 2) s += 14;
  if (/nutrition|ingredient|label|back|barcode|pack/.test(url)) s += 3;
  if (/\.webp/i.test(url)) s -= 5;
  if (alt.length > 30) s += 2;
  if (/_SL1[0-9]{3}|_AC_SL/.test(url)) s += 2;
  return s;
}

/**
 * @param {Array<{ url: string, alt?: string }>} images
 */
function extractFromImageAltsOnly(images) {
  let text = '';
  for (const img of images) {
    if (img.alt) text += '\n' + img.alt;
  }
  if (!text.trim()) return null;
  const variantBlocks = collectAllNutritionBlocks(text);
  return {
    text,
    nutrition: parseBestNutritionBlock(text),
    barcode: extractBarcodeFromText(text),
    ingredientsText: extractIngredientsFromOcr(text),
    variants: variantBlocks.length >= 2 ? variantBlocks : undefined,
    sources: ['product_image_alt'],
  };
}

/**
 * @param {string} url
 * @returns {Promise<{ buffer: Buffer, contentType: string } | null>}
 */
async function fetchImageBuffer(url) {
  try {
    const res = await fetch(url, {
      headers: {
        Referer: 'https://www.amazon.in/',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500 || buf.length > 12_000_000) return null;
    return { buffer: buf, contentType };
  } catch (e) {
    console.warn('[EcoHealth] image fetch failed', url, e.message);
    return null;
  }
}
