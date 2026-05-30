/**
 * Normalize OCR text for more reliable nutrition parsing.
 * @param {string} text
 */
export function normalizeOcrText(text) {
  if (!text) return '';
  return text
    .replace(/\r/g, '\n')
    .replace(/[|]/g, 'l')
    .replace(/k\s*c\s*a\s*l/gi, 'kcal')
    .replace(/Nutrition\s*Inf(?:ormation)?/gi, 'Nutrition Information')
    .replace(/([Ee]nergy)\s+([\d.]+)/g, '$1: $2')
    .replace(/\s+/g, ' ');
}

/**
 * Stable key for deduping nutrition blocks from multiple images.
 * @param {Record<string, number | string> | null} nutrition
 */
export function nutritionFingerprint(nutrition) {
  if (!nutrition) return '';
  const e = nutrition.energy_kcal ?? '';
  const s = nutrition.sugar_g ?? '';
  const f = nutrition.fat_g ?? '';
  const p = nutrition.protein_g ?? '';
  return `${e}|${s}|${f}|${p}`;
}

/**
 * Parse nutrition facts text (page, OCR, or labels). Supports Indian FSSAI-style labels.
 * @param {string} text
 * @returns {Record<string, number | string> | null}
 */
export function parseNutritionTable(text) {
  if (!text || !text.trim()) return null;
  text = normalizeOcrText(text);

  const nutrition = { per: '100g' };  const patterns = [
    [/energy[:\s]*(?:\([^)]*\))?[:\s]*([\d.]+)\s*kcal/i, 'energy_kcal'],
    [/protein[:\s]*(?:\([^)]*\))?[:\s]*([\d.]+)\s*g/i, 'protein_g'],
    [/carbohydrate[s]?[:\s]*(?:\([^)]*\))?[:\s]*([\d.]+)\s*g/i, 'carbs_g'],
    [/carb[s]?[:\s]*(?:\([^)]*\))?[:\s]*([\d.]+)\s*g/i, 'carbs_g'],
    [/total\s+sugars?[:\s]*([\d.]+)\s*g/i, 'sugar_g'],
    [/added\s+sugars?[:\s]*([\d.]+)\s*g/i, 'added_sugar_g'],
    [/(?<!added\s)(?<!total\s)sugars?[:\s]*([\d.]+)\s*g/i, 'sugar_g'],
    [/total\s+fat[:\s]*([\d.]+)\s*g/i, 'fat_g'],
    [/(?<!saturated\s)(?<!total\s)fat[:\s]*([\d.]+)\s*g/i, 'fat_g'],
    [/saturat(?:ed|es)?\s*fat[:\s]*([\d.]+)\s*g/i, 'saturated_fat_g'],
    [/trans\s*fat[:\s]*([\d.]+)\s*g/i, 'trans_fat_g'],
    [/fibre|fiber[:\s]*([\d.]+)\s*g/i, 'fiber_g'],
    [/salt[:\s]*([\d.]+)\s*g/i, 'salt_g'],
    [/sodium[:\s]*([\d.]+)\s*mg/i, 'sodium_mg'],
    [/sodium[:\s]*([\d.]+)\s*g/i, 'sodium_g'],
    [/cholesterol[:\s]*([\d.]+)\s*mg/i, 'cholesterol_mg'],
  ];

  for (const [re, key] of patterns) {
    const m = text.match(re);
    if (m && nutrition[key] == null) nutrition[key] = parseFloat(m[1]);
  }

  if (nutrition.energy_kcal == null) {
    const km = text.match(/([\d]{3,4})\s*kcal/i);
    if (km) nutrition.energy_kcal = parseFloat(km[1]);
  }

  if (nutrition.added_sugar_g != null && nutrition.sugar_g == null) {
    nutrition.sugar_g = nutrition.added_sugar_g;
  }

  if (text.match(/per\s+serving/i)) nutrition.per = 'serving';

  const keys = Object.keys(nutrition).filter((k) => k !== 'per');
  return keys.length > 0 ? nutrition : null;
}

/**
 * Pick the richest nutrition block when OCR returns multiple variants (e.g. combo pack).
 * @param {string} text
 */
export function parseBestNutritionBlock(text) {
  const chunks = text.split(/nutrition\s*information/i);
  let best = null;
  let bestCount = 0;

  const tryParse = (chunk) => {
    const n = parseNutritionTable(chunk);
    if (!n) return;
    const count = Object.keys(n).filter((k) => k !== 'per').length;
    if (count > bestCount) {
      bestCount = count;
      best = n;
    }
  };

  if (chunks.length > 1) {
    for (const chunk of chunks) tryParse(chunk);
  } else {
    tryParse(text);
  }

  return best;
}

/**
 * @param {string} text
 * @returns {string | null} digits-only barcode
 */
export function extractBarcodeFromText(text) {
  if (!text) return null;
  const candidates = text.match(/\b(\d[\d\s]{10,18}\d)\b/g) || [];
  for (const raw of candidates) {
    const digits = raw.replace(/\s/g, '');
    if (digits.length >= 8 && digits.length <= 14) return digits;
  }
  return null;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function extractIngredientsFromOcr(text) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf('ingredients');
  if (idx === -1) return '';
  let rest = text.slice(idx + 'ingredients'.length).replace(/^[\s:：]+/, '');
  const stop = rest.search(/allergen|nutrition\s*information|store\s*in|customer\s*care|fssai/i);
  if (stop > 0) rest = rest.slice(0, stop);
  return rest.replace(/\s+/g, ' ').trim().slice(0, 2000);
}
