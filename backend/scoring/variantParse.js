import {
  parseNutritionTable,
  extractBarcodeFromText,
  extractIngredientsFromOcr,
  normalizeOcrText,
  nutritionFingerprint,
} from './nutritionParse.js';

/** @type {Array<{ re: RegExp, name: string }>} */
const VARIANT_HEADERS = [
  { re: /\bCRANBERRY\b/i, name: 'Cranberry' },
  { re: /\bDARK\s*CHOCOLATE\s*WITH\s*CRANBERRY\b/i, name: 'Cranberry' },
  { re: /\bFRUIT\s*(?:&|AND)\s*NUT\b/i, name: 'Fruit & Nut' },
  { re: /\b70\s*%\s*DARK\b/i, name: '70% Dark' },
  { re: /\bINTENSE\s*70\b/i, name: '70% Dark' },
  { re: /\bINTENSE\s*DARK\b/i, name: '70% Dark' },
  { re: /\bBOURNVILLE\s*INTENSE\b/i, name: '70% Dark' },
  { re: /\bORANGE\b/i, name: 'Orange' },
  { re: /\bALMOND\b/i, name: 'Almond' },
];

/** @type {Record<string, RegExp[]>} */
const VARIANT_TEXT_HINTS = {
  Cranberry: [/\bcranberry\b/i, /\bwith\s*cranberry\b/i],
  'Fruit & Nut': [/fruit\s*(?:&|and)\s*nut/i],
  '70% Dark': [/70\s*%?\s*dark/i, /\bintense\b/i, /\bintense\s*70\b/i],
};

/**
 * @param {string} name
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * @param {string} title
 * @returns {boolean}
 */
export function isComboProductTitle(title) {
  if (!title) return false;
  if (/\bcombo\b|assorted|variety\s*pack|mixed\s*pack/i.test(title)) return true;
  const multiPack = title.match(/\d+\s*x\s/gi) || [];
  return multiPack.length >= 2;
}

/**
 * Detect variant names from Amazon title (e.g. Bournville combo listing).
 * @param {string} title
 * @returns {Array<{ id: string, name: string }>}
 */
export function detectVariantsFromTitle(title) {
  if (!title || !isComboProductTitle(title)) return [];

  /** @type {Array<{ id: string, name: string }>} */
  const found = [];
  if (/\bcranberry\b/i.test(title)) found.push({ id: 'cranberry', name: 'Cranberry' });
  if (/fruit\s*(?:&|and)\s*nut/i.test(title)) found.push({ id: 'fruit-nut', name: 'Fruit & Nut' });
  if (/70\s*%?\s*dark|intense|70%\s*dark\s*chocolate/i.test(title)) {
    found.push({ id: '70-dark', name: '70% Dark' });
  }

  return found.length >= 2 ? found : [];
}

/**
 * Split OCR text into nutrition-only blocks (when variant headers are missing).
 * @param {string} text
 */
export function splitNutritionOnlyBlocks(text) {
  if (!text) return [];
  const parts = text.split(/nutrition\s*information/i);
  if (parts.length < 2) return [];

  return parts
    .slice(1)
    .map((chunk, i) => {
      const blockText = 'Nutrition Information' + chunk;
      return {
        index: i,
        nutrition: parseNutritionTable(blockText),
        ingredientsText: extractIngredientsFromOcr(blockText),
        barcode: extractBarcodeFromText(blockText),
        text: blockText,
      };
    })
    .filter((b) => b.nutrition && Object.keys(b.nutrition).filter((k) => k !== 'per').length >= 3);
}

/**
 * Split combo-pack OCR into per-variant text blocks.
 * @param {string} text
 * @returns {Array<{ id: string, name: string, text: string }>}
 */
/**
 * @param {string} variantName
 * @param {string} chunkText
 */
function chunkMatchesVariantName(variantName, chunkText) {
  const hints = VARIANT_TEXT_HINTS[variantName];
  if (!hints) return false;
  const t = chunkText.toLowerCase();
  return hints.some((re) => re.test(t));
}

/**
 * Collect every distinct nutrition block from OCR (headers + repeated "Nutrition Information").
 * @param {string} text
 */
export function collectAllNutritionBlocks(text) {
  if (!text) return [];
  text = normalizeOcrText(text);

  /** @type {Array<{ id: string, name: string, nutrition: object, ingredientsText: string, barcode: string | null, text: string }>} */
  const blocks = [];

  for (const v of parseVariantBlocks(text)) {
    if (v.nutrition) blocks.push({ ...v, text: v.text || '' });
  }

  for (const chunk of splitNutritionOnlyBlocks(text)) {
    if (!chunk.nutrition) continue;
    blocks.push({
      id: `nutrition-${chunk.index}`,
      name: chunk.name || `Label ${chunk.index + 1}`,
      nutrition: chunk.nutrition,
      ingredientsText: chunk.ingredientsText || '',
      barcode: chunk.barcode || null,
      text: chunk.text || '',
    });
  }

  return dedupeNutritionBlocks(blocks);
}

/**
 * @param {Array<{ nutrition?: object | null }>} blocks
 */
export function dedupeNutritionBlocks(blocks) {
  /** @type {Array<object>} */
  const out = [];
  const seen = new Set();
  for (const b of blocks) {
    const fp = nutritionFingerprint(b.nutrition);
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    out.push(b);
  }
  return out;
}

/**
 * Map title variants to the best OCR nutrition block (by name in text, then macro fingerprint).
 * @param {Array<{ id: string, name: string }>} titleVariants
 * @param {Array<{ id?: string, name?: string, nutrition?: object | null, ingredientsText?: string, barcode?: string | null, text?: string }>} blocks
 */
export function assignBlocksToTitleVariants(titleVariants, blocks) {
  if (!titleVariants.length) return [];
  const pool = [...blocks];
  const used = new Set();

  return titleVariants.map((tv) => {
    let matchIdx = pool.findIndex(
      (b, i) =>
        !used.has(i) &&
        (chunkMatchesVariantName(tv.name, b.text || '') ||
          (b.name && namesMatchVariant(tv.name, b.name)))
    );

    if (matchIdx === -1 && tv.name.includes('70')) {
      matchIdx = pool.findIndex(
        (b, i) =>
          !used.has(i) &&
          b.nutrition &&
          (b.nutrition.sugar_g == null || b.nutrition.sugar_g < 35) &&
          (b.nutrition.energy_kcal == null || b.nutrition.energy_kcal >= 560)
      );
    }

    if (matchIdx === -1 && tv.name.includes('Cranberry')) {
      matchIdx = pool.findIndex(
        (b, i) =>
          !used.has(i) &&
          b.nutrition &&
          b.nutrition.energy_kcal != null &&
          b.nutrition.energy_kcal >= 520 &&
          b.nutrition.energy_kcal <= 530
      );
    }

    if (matchIdx === -1) {
      matchIdx = pool.findIndex((_, i) => !used.has(i) && pool[i].nutrition);
    }

    if (matchIdx === -1) {
      return {
        id: tv.id,
        name: tv.name,
        nutrition: null,
        ingredientsText: '',
        barcode: null,
        nutritionInferred: false,
      };
    }

    used.add(matchIdx);
    const b = pool[matchIdx];
    return {
      id: tv.id,
      name: tv.name,
      nutrition: b.nutrition || null,
      ingredientsText: b.ingredientsText || '',
      barcode: b.barcode || null,
      nutritionInferred: false,
    };
  });
}

/**
 * @param {string} a
 * @param {string} b
 */
function namesMatchVariant(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  if (x.includes('cranberry') && y.includes('cranberry')) return true;
  if (x.includes('fruit') && y.includes('fruit')) return true;
  if ((x.includes('70') || x.includes('dark') || x.includes('intense')) && (y.includes('70') || y.includes('dark') || y.includes('intense')))
    return true;
  return false;
}

export function splitOcrIntoVariants(text) {
  if (!text || text.length < 80) return [];
  text = normalizeOcrText(text);
  /** @type {Array<{ index: number, name: string }>} */
  const hits = [];
  for (const { re, name } of VARIANT_HEADERS) {
    const m = text.match(re);
    if (m && m.index != null) hits.push({ index: m.index, name });
  }

  hits.sort((a, b) => a.index - b.index);

  /** @type {Array<{ index: number, name: string }>} */
  const unique = [];
  const seenNames = new Set();
  for (const h of hits) {
    if (seenNames.has(h.name)) continue;
    seenNames.add(h.name);
    unique.push(h);
  }

  if (unique.length < 2) {
    const blocks = text.split(/nutrition\s*information/i);
    if (blocks.length >= 3) {
      return blocks
        .slice(1)
        .map((chunk, i) => ({
          id: `variant-${i + 1}`,
          name: `Variant ${i + 1}`,
          text: 'Nutrition Information' + chunk,
        }))
        .filter((v) => parseNutritionTable(v.text));
    }
    return [];
  }

  /** @type {Array<{ id: string, name: string, text: string }>} */
  const variants = [];
  for (let i = 0; i < unique.length; i++) {
    const start = unique[i].index;
    const end = i + 1 < unique.length ? unique[i + 1].index : text.length;
    const chunk = text.slice(start, end);
    if (chunk.length < 40) continue;
    if (!parseNutritionTable(chunk)) continue;
    variants.push({
      id: slugify(unique[i].name),
      name: unique[i].name,
      text: chunk,
    });
  }

  return variants;
}

/**
 * @param {string} text
 * @returns {Array<{ id: string, name: string, nutrition: object | null, ingredientsText: string, barcode: string | null }>}
 */
export function parseVariantBlocks(text) {
  const chunks = splitOcrIntoVariants(text);
  return chunks.map((c) => ({
    id: c.id,
    name: c.name,
    text: c.text,
    nutrition: parseNutritionTable(c.text),
    ingredientsText: extractIngredientsFromOcr(c.text),
    barcode: extractBarcodeFromText(c.text),
  }));
}
