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

const MAX_IMAGES = 8;

/**
 * Prefer full-resolution Amazon gallery URLs for OCR.
 * @param {string} url
 */
function upgradeAmazonImageUrl(url) {
  if (!url) return url;
  return url
    .replace(/\._AC_[A-Z0-9_]+_\./, '._AC_SL1500_.')
    .replace(/\._SX\d+_\./, '._SL1500_.')
    .replace(/\._SY\d+_\./, '._SL1500_.')
    .replace(/\._SL\d+_\./, '._SL1500_.');
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

    for (const img of ranked) {
      const altText = (img.alt || '').trim();
      if (altText.length > 20) combinedText += '\n' + altText;

      const buffer = await fetchImageBuffer(img.url);
      if (!buffer) continue;

      const {
        data: { text: rawText },
      } = await worker.recognize(buffer);
      if (!rawText?.trim()) continue;

      const text = normalizeOcrText(rawText);
      combinedText += '\n' + text;

      const blocks = collectAllNutritionBlocks(text);
      for (const b of blocks) {
        perImageBlocks.push(b);
      }

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

    if (!combinedText.trim()) return null;

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
      sources: ['product_image_ocr'],
    };
  } finally {
    if (worker) await worker.terminate();
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
  if (/nutrition|ingredient|label|back|barcode|pack/.test(url)) s += 3;
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
 */
async function fetchImageBuffer(url) {
  try {
    const res = await fetch(url, {
      headers: {
        Referer: 'https://www.amazon.in/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500 || buf.length > 12_000_000) return null;
    return buf;
  } catch (e) {
    console.warn('[EcoHealth] image fetch failed', url, e.message);
    return null;
  }
}
