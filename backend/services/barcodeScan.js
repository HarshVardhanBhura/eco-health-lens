import { extractBarcodeFromText } from '../scoring/nutritionParse.js';

/**
 * Fast digit-only OCR pass to read EAN barcodes from pack photos.
 * Much cheaper than full nutrition-table OCR — run before OFF lookup.
 * @param {Array<{ base64: string, mimeType?: string, url?: string, barcodeImage?: boolean }>} imageBuffers
 * @param {{ maxImages?: number }} [options]
 */
export async function extractBarcodesFromBuffers(imageBuffers, options = {}) {
  const maxImages = options.maxImages ?? 6;
  const buffers = [...(imageBuffers || [])]
    .sort((a, b) => (b.barcodeImage ? 1 : 0) - (a.barcodeImage ? 1 : 0))
    .slice(0, maxImages);

  if (!buffers.length) return { barcode: null, barcodes: [], sources: [] };

  let createWorker;
  try {
    ({ createWorker } = await import('tesseract.js'));
  } catch {
    return { barcode: null, barcodes: [], sources: [] };
  }

  /** @type {Set<string>} */
  const barcodesFound = new Set();
  let worker;

  try {
    worker = await createWorker('eng');
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      tessedit_char_whitelist: '0123456789',
    });

    for (const bufImg of buffers) {
      if (!bufImg?.base64) continue;
      let buffer;
      try {
        buffer = Buffer.from(bufImg.base64, 'base64');
      } catch {
        continue;
      }
      const result = await worker.recognize(buffer);
      const text = result?.data?.text || '';
      const b = extractBarcodeFromText(text);
      if (b) barcodesFound.add(b);
      const compact = text.replace(/\D/g, '');
      for (const m of compact.match(/890\d{10}/g) || []) {
        barcodesFound.add(m);
      }
      if (barcodesFound.size) break;
    }
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* ignore */
      }
    }
  }

  const barcodes = [...barcodesFound];
  const barcode =
    barcodes.find((b) => b.length === 13 && b.startsWith('890')) ||
    barcodes.find((b) => b.length === 13) ||
    barcodes[0] ||
    null;

  if (barcode) {
    console.info('[EcoHealth] barcode scan found:', barcode);
  }

  return {
    barcode,
    barcodes,
    sources: barcodes.length ? ['barcode_scan'] : [],
  };
}

/**
 * @param {object | null | undefined} product Open Food Facts product
 */
export function offHasUsableNutrition(product) {
  if (!product) return false;
  const n = product.nutriments || {};
  return (
    n['energy-kcal_100g'] != null ||
    n.proteins_100g != null ||
    n.carbohydrates_100g != null ||
    product.nutriscore_grade != null
  );
}
