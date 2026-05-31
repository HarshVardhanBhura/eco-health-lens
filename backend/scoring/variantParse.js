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
  '70% Dark': [/70\s*%?\s*dark/i, /\bintense\s*70\b/i, /\bintense\s*dark\b/i, /\bintense\b/i],
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
 * Parses each "2 x Flavour …" segment so "Dark Chocolate" in the brand name is not mistaken for a variant.
 * @param {string} title
 * @returns {Array<{ id: string, name: string }>}
 */
export function detectVariantsFromTitle(title) {
  if (!title || !isComboProductTitle(title)) return [];

  /** @type {Array<{ id: string, name: string }>} */
  const found = [];
  const seen = new Set();

  const add = (id, name) => {
    if (seen.has(id)) return;
    seen.add(id);
    found.push({ id, name });
  };

  const packSegments = title.match(/\d+\s*x\s*[^,)]+/gi) || [];
  for (const seg of packSegments) {
    if (/cranberr/i.test(seg)) add('cranberry', 'Cranberry');
    else if (/fruit\s*(?:&|and)\s*nut/i.test(seg)) add('fruit-nut', 'Fruit & Nut');
    else if (/70\s*%?\s*dark|intense\s*70|intense\s*dark|\bintense\b/i.test(seg)) add('70-dark', '70% Dark');
  }

  if (found.length < 2) {
    if (/cranberr/i.test(title)) add('cranberry', 'Cranberry');
    if (/fruit\s*(?:&|and)\s*nut/i.test(title)) add('fruit-nut', 'Fruit & Nut');
    if (/(?:\d+\s*x\s*)?70\s*%?\s*dark|intense\s*70|\bintense\b/i.test(title)) add('70-dark', '70% Dark');
  }

  if (packSegments.length >= 3) {
    return [
      { id: 'cranberry', name: 'Cranberry' },
      { id: 'fruit-nut', name: 'Fruit & Nut' },
      { id: '70-dark', name: '70% Dark' },
    ];
  }

  return found.length >= 2 ? found : [];
}

/** Standard 3-flavour Bournville-style combo slot order (low → high energy on label). */
const THREE_PACK_SLOT_IDS = ['cranberry', 'fruit-nut', '70-dark'];

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
    .filter((b) => {
      if (!b.nutrition) return false;
      const keys = Object.keys(b.nutrition).filter((k) => k !== 'per');
      return keys.length >= 2 || b.nutrition.energy_kcal != null;
    });
}

/**
 * Split wide combo-back OCR by flavour headers (CRANBERRY | FRUIT & NUT | 70% DARK).
 * @param {string} text
 */
export function splitByVariantHeaders(text) {
  if (!text) return [];
  text = normalizeOcrText(text);

  /** @type {Array<{ index: number, id: string, name: string }>} */
  const headers = [
    { re: /\bCRANBERRY\b/i, id: 'cranberry', name: 'Cranberry' },
    { re: /\bFRUIT\s*(?:&|AND)\s*NUT\b/i, id: 'fruit-nut', name: 'Fruit & Nut' },
    { re: /\b70\s*%\s*DARK\b/i, id: '70-dark', name: '70% Dark' },
    { re: /\bINTENSE\b/i, id: '70-dark', name: '70% Dark' },
  ];

  /** @type {Array<{ index: number, id: string, name: string }>} */
  const hits = [];
  for (const h of headers) {
    const flags = h.re.flags.includes('g') ? h.re.flags : h.re.flags + 'g';
    const re = new RegExp(h.re.source, flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!hits.some((x) => x.id === h.id && Math.abs(x.index - m.index) < 30)) {
        hits.push({ index: m.index, id: h.id, name: h.name });
      }
    }
  }

  hits.sort((a, b) => a.index - b.index);
  if (hits.length < 2) return [];

  /** @type {Array<object>} */
  const blocks = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index;
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    const chunk = text.slice(start, end);
    const nutrition = parseNutritionTable(chunk);
    if (!nutrition) continue;
    blocks.push({
      id: hits[i].id,
      name: hits[i].name,
      nutrition,
      ingredientsText: extractIngredientsFromOcr(chunk),
      barcode: extractBarcodeFromText(chunk),
      text: chunk,
    });
  }
  return blocks;
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

  for (const v of splitByVariantHeaders(text)) {
    blocks.push(v);
  }

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
/**
 * @param {object} nutrition
 * @param {string} variantName
 */
function nutritionMatchesVariantProfile(nutrition, variantName) {
  if (!nutrition) return false;
  const e = nutrition.energy_kcal;
  const s = nutrition.sugar_g;
  if (variantName.includes('Cranberry')) {
    return e != null && e >= 518 && e <= 532 && (s == null || s >= 42);
  }
  if (variantName.includes('Fruit')) {
    return e != null && e >= 528 && e <= 538 && (s == null || (s >= 42 && s <= 47));
  }
  if (variantName.includes('70') || /\bintense\b/i.test(variantName)) {
    return (e != null && e >= 545 && e <= 570) || (s != null && s < 32);
  }
  return false;
}

/**
 * @param {Array<{ nutrition?: object | null }>} blocks
 * @param {Set<number>} used
 */
function pickBlockByProfile(blocks, used, variantName) {
  return blocks.findIndex(
    (b, i) => !used.has(i) && nutritionMatchesVariantProfile(b.nutrition, variantName)
  );
}

/**
 * Assign nutrition blocks to 3 combo slots by ascending label energy (Bournville-style).
 * @param {Array<{ id: string, name: string }>} titleVariants
 * @param {Array<object>} blocks
 */
function assignThreePackByEnergy(titleVariants, blocks) {
  const byId = Object.fromEntries(titleVariants.map((t) => [t.id, t]));
  const sorted = [...blocks]
    .filter((b) => b.nutrition && b.nutrition.energy_kcal != null)
    .sort((a, b) => a.nutrition.energy_kcal - b.nutrition.energy_kcal);

  return THREE_PACK_SLOT_IDS.filter((id) => byId[id]).map((id, i) => {
    const tv = byId[id];
    const b = sorted[i] || sorted[sorted.length - 1] || {};
    return {
      id: tv.id,
      name: tv.name,
      nutrition: b.nutrition ? { ...b.nutrition } : null,
      ingredientsText: b.ingredientsText || '',
      barcode: b.barcode || null,
      text: b.text || '',
      nutritionInferred: false,
    };
  });
}

export function assignBlocksToTitleVariants(titleVariants, blocks) {
  if (!titleVariants.length) return [];

  const withNutrition = blocks.filter((b) => b.nutrition);
  if (titleVariants.length >= 3 && withNutrition.length >= 2) {
    const energyAssigned = assignThreePackByEnergy(titleVariants, blocks);
    const nameRefined = energyAssigned.map((slot) => {
      const byName = blocks.find(
        (b) =>
          b.nutrition &&
          (chunkMatchesVariantName(slot.name, b.text || '') ||
            (b.name && namesMatchVariant(slot.name, b.name)) ||
            nutritionMatchesVariantProfile(b.nutrition, slot.name))
      );
      if (!byName?.nutrition) return slot;
      return {
        ...slot,
        nutrition: { ...byName.nutrition },
        ingredientsText: byName.ingredientsText || slot.ingredientsText,
        barcode: byName.barcode || slot.barcode,
        text: byName.text || slot.text,
      };
    });
    return nameRefined;
  }

  const pool = [...blocks];
  const used = new Set();

  return titleVariants.map((tv) => {
    let matchIdx = pool.findIndex(
      (b, i) =>
        !used.has(i) &&
        (chunkMatchesVariantName(tv.name, b.text || '') ||
          (b.name && namesMatchVariant(tv.name, b.name)))
    );

    if (matchIdx === -1) matchIdx = pickBlockByProfile(pool, used, tv.name);

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
      nutrition: b.nutrition ? { ...b.nutrition } : null,
      ingredientsText: b.ingredientsText || '',
      barcode: b.barcode || null,
      text: b.text || '',
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
  if ((x.includes('70') || /\bintense\b/i.test(x)) && (y.includes('70') || /\bintense\b/i.test(y))) return true;
  return false;
}

export function splitOcrIntoVariants(text) {
  if (!text || text.length < 80) return [];
  text = normalizeOcrText(text);
  /** @type {Array<{ index: number, name: string }>} */
  const hits = [];
  for (const { re, name } of VARIANT_HEADERS) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const regex = new RegExp(re.source, flags);
    let m;
    while ((m = regex.exec(text)) !== null) {
      hits.push({ index: m.index, name });
    }
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
