import {
  parseBestNutritionBlock,
  extractBarcodeFromText,
  extractIngredientsFromOcr,
  normalizeOcrText,
  nutritionFieldCount,
  hasPackLabelSection,
} from '../scoring/nutritionParse.js';
import { sanitizeIngredientsText } from '../scoring/ingredients.js';
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
/**
 * @param {string} url
 */
function amazonImageIdFromUrl(url) {
  const m = url?.match(/\/images\/I\/([A-Za-z0-9+_-]+)/i);
  return m ? m[1].replace(/\._.*$/, '') : null;
}

function upgradeAmazonImageUrl(url) {
  if (!url) return url;

  const id = amazonImageIdFromUrl(url);
  if (id && /_SX\d+|_SY\d+|_CR,0,0,\d+/i.test(url)) {
    const host = url.match(/^https?:\/\/[^/]+/)?.[0] || 'https://m.media-amazon.com';
    return `${host}/images/I/${id}._SL1500_.jpg`;
  }

  let u = url
    .replace(/\._AC_[A-Z0-9_]+_\./, '._AC_SL1500_.')
    .replace(/\._SX\d+_\./, '._SL1500_.')
    .replace(/\._SY\d+_\./, '._SL1500_.');
  if (/_SL\d+_/i.test(u) && !/_SL1[0-9]{3}/i.test(u)) {
    u = u.replace(/\._SL\d+_\./, '._SL1500_.');
  }
  if (/\.webp(\?|$)/i.test(u)) u = u.replace(/\.webp(\?.*)?$/i, '.jpg$1');

  if (id && !/_SL1[0-9]{3}/i.test(u)) {
    const host = u.match(/^https?:\/\/[^/]+/)?.[0] || 'https://m.media-amazon.com';
    return `${host}/images/I/${id}._SL1500_.jpg`;
  }

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

  if (text.trim().length < 120 || !/nutrition|energy|kcal|per\s*100/i.test(text)) {
    try {
      await worker.setParameters({ tessedit_pageseg_mode: '4' });
      const table = await recognizeBufferSafe(worker, buffer, url);
      if (table.trim().length > text.trim().length) text = table;
    } finally {
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
    }
  }

  return text;
}

/**
 * @param {Array<{ url: string, alt?: string }>} images
 * @returns {Promise<{ text: string, nutrition: object | null, barcode: string | null, ingredientsText: string, sources: string[], variants?: object[] } | null>}
 */
/**
 * @param {Set<string>} barcodesFound
 */
function collectBarcodesFromText(text, barcodesFound) {
  const b = extractBarcodeFromText(text);
  if (b) barcodesFound.add(b);
}

/**
 * @param {Set<string>} barcodesFound
 */
function pickBestBarcode(barcodesFound) {
  const list = [...barcodesFound];
  if (!list.length) return null;
  const ean13 = list.filter((b) => b.length === 13);
  return ean13[0] || list.sort((a, b) => b.length - a.length)[0];
}

/**
 * @param {object} state
 * @param {string} text
 */
function applyOcrText(state, text) {
  state.combinedText += '\n' + text;

  const blocks = collectAllNutritionBlocks(text);
  for (const b of blocks) {
    state.perImageBlocks.push(b);
  }

  const nutrition = parseBestNutritionBlock(text);
  if (nutrition) {
    const count = Object.keys(nutrition).filter((k) => k !== 'per').length;
    if (count > state.bestCount) {
      state.bestCount = count;
      state.bestNutrition = nutrition;
    }
  }

  collectBarcodesFromText(text, state.barcodesFound);
  const ing = sanitizeIngredientsText(extractIngredientsFromOcr(text));
  if (ing.length > state.ingredientsText.length) state.ingredientsText = ing;
}

/**
 * @param {Array<{ url: string, alt?: string }>} images
 * @param {{ selectedImageUrl?: string, imageBuffers?: Array<{ base64: string, mimeType?: string, alt?: string, url?: string }> }} [options]
 */
export async function extractFromProductImages(images, options = {}) {
  const imageBuffers = options.imageBuffers || [];
  let ranked = [...(images || [])]
    .filter((img) => img?.url?.startsWith('http'))
    .map((img) => ({ ...img, url: upgradeAmazonImageUrl(img.url) }));

  const selected = options.selectedImageUrl
    ? upgradeAmazonImageUrl(options.selectedImageUrl)
    : null;
  if (selected) {
    const hit = ranked.find((i) => urlsMatch(i.url, selected));
    if (hit && isLikelyNutritionImage(hit)) {
      hit.priority = (hit.priority || 0) + 80;
    }
  }

  ranked = ranked
    .sort(
      (a, b) =>
        (b.priority || 0) + scoreImage(b) - ((a.priority || 0) + scoreImage(a))
    )
    .slice(0, MAX_IMAGES);

  if (!ranked.length && !imageBuffers.length) return null;

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

    const state = {
      combinedText: '',
      bestNutrition: null,
      bestCount: 0,
      ingredientsText: '',
      perImageBlocks: [],
      barcodesFound: new Set(),
    };
    let ocrAttempts = 0;
    let ocrSuccess = 0;
    const bufferedUrls = new Set(
      imageBuffers.map((b) => b.url).filter(Boolean)
    );

    for (const bufImg of imageBuffers) {
      if (!bufImg?.base64) continue;
      let buffer;
      try {
        buffer = Buffer.from(bufImg.base64, 'base64');
      } catch {
        continue;
      }
      const contentType = bufImg.mimeType || 'image/jpeg';
      if (!isSupportedOcrImage(buffer, contentType)) continue;

      ocrAttempts += 1;
      const rawText = await recognizeWithFallback(
        worker,
        buffer,
        bufImg.url || 'extension-buffer'
      );
      if (!rawText?.trim()) continue;

      ocrSuccess += 1;
      applyOcrText(state, normalizeOcrText(rawText));
      if (nutritionFieldCount(state.bestNutrition) >= 4) break;
    }

    for (const img of ranked) {
      if (img.url && bufferedUrls.has(img.url)) continue;

      const altText = (img.alt || '').trim();
      if (altText.length > 20) state.combinedText += '\n' + altText;

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
      applyOcrText(state, normalizeOcrText(rawText));

      if (dedupeNutritionBlocks(state.perImageBlocks).length >= 3) break;
      if (nutritionFieldCount(state.bestNutrition) >= 4) break;
    }

    let { combinedText, bestNutrition, bestCount, ingredientsText, perImageBlocks, barcodesFound } =
      state;

    if (!bestNutrition || bestCount < 3) {
      const fromCombined = parseBestNutritionBlock(combinedText);
      const combinedCount = nutritionFieldCount(fromCombined);
      if (fromCombined && combinedCount > bestCount) {
        bestNutrition = fromCombined;
        bestCount = combinedCount;
      }
    }

    const barcode = pickBestBarcode(barcodesFound);

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

    const labelPackDetected =
      hasPackLabelSection(combinedText) &&
      (ingredientsText.length > 15 ||
        nutritionFieldCount(bestNutrition) >= 2 ||
        bestNutrition?.energy_kcal != null);

    return {
      text: combinedText,
      nutrition: bestNutrition,
      barcode,
      barcodes: [...barcodesFound],
      ingredientsText,
      variants: variantBlocks.length >= 2 ? variantBlocks : undefined,
      sources: ocrSuccess > 0 ? ['product_image_ocr'] : ['product_image_alt'],
      ocrImageCount: ocrSuccess,
      labelPackDetected,
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
function urlsMatch(a, b) {
  if (!a || !b) return false;
  const na = a.replace(/\?.*$/, '').replace(/\.webp$/i, '.jpg');
  const nb = b.replace(/\?.*$/, '').replace(/\.webp$/i, '.jpg');
  return na === nb || na.includes(nb.slice(-40)) || nb.includes(na.slice(-40));
}

/**
 * @param {{ alt?: string, url?: string }} img
 */
function isLikelyNutritionImage(img) {
  const alt = (img.alt || '').toLowerCase();
  const url = (img.url || '').toLowerCase();
  return (
    NUTRITION_ALT_RE.test(alt) ||
    /nutrition\s*information|per\s*100|ingredient|barcode|back\s*of/i.test(alt) ||
    /nutrition|ingredient|label|back/.test(url)
  );
}

function scoreImage(img) {
  let s = 0;
  const alt = (img.alt || '').toLowerCase();
  const url = (img.url || '').toLowerCase();
  if (NUTRITION_ALT_RE.test(alt)) s += 10;
  if (/nutrition(?:al)?\s*information|per\s*100\s*g|per\s*100g|net\s*quantity|fssai/i.test(alt))
    s += 12;
  if (/masala|instant\s+noodles|back\s*of|barcode/i.test(alt)) s += 6;
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
