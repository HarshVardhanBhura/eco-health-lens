/**
 * Normalize OCR text for more reliable nutrition parsing.
 * @param {string} text
 */
export function normalizeOcrText(text) {
  if (!text) return '';
  return text
    .replace(/\r/g, '\n')
    .replace(/k\s*c\s*a\s*l/gi, 'kcal')
    .replace(/Nutrition(?:al)?\s*Inf(?:ormation)?/gi, 'Nutrition Information')
    .replace(/([Ee]nergy)\s+([\d.]+)/g, '$1: $2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
 * FSSAI dual-column tables: "Per 100 g" then "Per serve" — take the per-100g column (first value).
 * @param {string} text
 */
/**
 * Line-by-line parser for OCR tables (Maggi A+ graphics, FSSAI packs).
 * Uses first numeric column as per-100g when a nutrition block is present.
 * @param {string} text
 */
function parseLineBasedNutrition(text) {
  const idx = text.search(/nutrition/i);
  if (idx < 0) return null;

  const block = text.slice(idx, idx + 4000);
  const nutrition = { per: '100g' };

  /** @type {Array<{ re: RegExp, key: string }>} */
  const rowDefs = [
    { re: /added\s+sugars?/i, key: 'added_sugar_g' },
    { re: /total\s+sugars?|^\s*[-–]?\s*total\s+sugars?/i, key: 'sugar_g' },
    { re: /saturated\s+fat/i, key: 'saturated_fat_g' },
    { re: /trans\s+fat/i, key: 'trans_fat_g' },
    { re: /total\s+fat/i, key: 'fat_g' },
    { re: /carbohydrate/i, key: 'carbs_g' },
    { re: /protein/i, key: 'protein_g' },
    { re: /energy/i, key: 'energy_kcal' },
    { re: /sodium/i, key: 'sodium_mg' },
  ];

  const lines = block.split(/\n/);
  for (const line of lines) {
    const nums = line.match(/\d+\.?\d*/g);
    if (!nums?.length) continue;
    const val = parseFloat(nums[0]);
    if (Number.isNaN(val)) continue;

    for (const { re, key } of rowDefs) {
      if (nutrition[key] != null) continue;
      if (!re.test(line)) continue;
      if (key === 'energy_kcal' && (val < 150 || val > 900)) continue;
      if (key === 'sodium_mg' && val < 50) continue;
      nutrition[key] = val;
      break;
    }
  }

  if (nutrition.added_sugar_g != null && nutrition.sugar_g == null) {
    nutrition.sugar_g = nutrition.added_sugar_g;
  }

  return nutritionFieldCount(nutrition) >= 2 ? nutrition : null;
}

function parseDualColumnPer100g(text) {
  const idx = text.search(/nutrition\s*information/i);
  const block = idx >= 0 ? text.slice(idx, idx + 2500) : text;
  const hasTable =
    /per\s*100|per\s*serve|%\s*gda|%\s*rda/i.test(block) ||
    /energy\s*\(?\s*kcal/i.test(block);

  if (!hasTable) return null;

  const nutrition = { per: '100g' };
  /** @type {Array<[RegExp, string]>} */
  const rowPatterns = [
    [/energy\s*\(?\s*kcal\s*\)?[^\d]*([\d.]+)/i, 'energy_kcal'],
    [/protein\s*\(?\s*g\s*\)?[^\d]*([\d.]+)/i, 'protein_g'],
    [/carbohydrate[s]?\s*\(?\s*g\s*\)?[^\d]*([\d.]+)/i, 'carbs_g'],
    [/total\s+sugars?\s*\(?\s*g\s*\)?[^\d]*([\d.]+)/i, 'sugar_g'],
    [/[-–]?\s*total\s+sugars?\s*\(?\s*g\s*\)?[^\d]*([\d.]+)/i, 'sugar_g'],
    [/added\s+sugars?\s*\(?\s*g\s*\)?[^\d]*([\d.]+)/i, 'added_sugar_g'],
    [/total\s+fat\s*\(?\s*g\s*\)?[^\d]*([\d.]+)/i, 'fat_g'],
    [/saturated\s+fat(?:ty acids)?\s*\(?\s*g\s*\)?[^\d]*([\d.]+)/i, 'saturated_fat_g'],
    [/trans\s+fat(?:ty acids)?\s*\(?\s*g\s*\)?[^\d]*([\d.]+)/i, 'trans_fat_g'],
    [/sodium\s*\(?\s*mg\s*\)?[^\d]*([\d.]+)/i, 'sodium_mg'],
    [/fibre|fiber\s*\(?\s*g\s*\)?[^\d]*([\d.]+)/i, 'fiber_g'],
  ];

  for (const [re, key] of rowPatterns) {
    const m = block.match(re);
    if (m && nutrition[key] == null) nutrition[key] = parseFloat(m[1]);
  }

  if (nutrition.added_sugar_g != null && nutrition.sugar_g == null) {
    nutrition.sugar_g = nutrition.added_sugar_g;
  }

  if (nutritionFieldCount(nutrition) >= 2) return nutrition;
  return parseLineBasedNutrition(text);
}

/**
 * @param {string} text
 */
export function hasPackLabelSection(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    /nutrition\s*information|nutritional\s*information|nutr[il]tion\s*inf/i.test(t) ||
    /per\s*100\s*g|per\s*serve|%\s*gda|%\s*rda/i.test(t) ||
    (/energy\s*\(?\s*kcal/i.test(t) && /protein|carbohydrate|sodium/i.test(t)) ||
    /noodles\s*:|tastemaker|refined wheat flour/i.test(t)
  );
}

/**
 * Parse nutrition facts text (page, OCR, or labels). Supports Indian FSSAI-style labels.
 * @param {string} text
 * @returns {Record<string, number | string> | null}
 */
export function parseNutritionTable(text) {
  if (!text || !text.trim()) return null;
  text = normalizeOcrText(text);

  const dual = parseDualColumnPer100g(text);
  if (dual) return dual;

  const lineBased = parseLineBasedNutrition(text);
  if (lineBased) return lineBased;

  const nutrition = { per: '100g' };
  const patterns = [
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

  if (nutrition.energy_kcal == null) {
    const em = text.match(/energy[^0-9]{0,40}([\d]{3,4})\b/i);
    if (em) nutrition.energy_kcal = parseFloat(em[1]);
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
  const chunks = text.split(/nutrition(?:al)?\s*information/i);
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
/**
 * @param {string} digits
 */
function isPlausibleBarcode(digits) {
  if (!/^\d{8,14}$/.test(digits)) return false;
  if (digits.length === 13 && digits.startsWith('890')) return true;
  if (digits.length === 13) return true;
  if (digits.length === 8 || digits.length === 12) return true;
  return false;
}

export function extractBarcodeFromText(text) {
  if (!text) return null;
  /** @type {Set<string>} */
  const found = new Set();

  const compact = text.replace(/[^\d]/g, '');
  const india13 = compact.match(/890\d{10}/g);
  if (india13) india13.forEach((b) => found.add(b));

  for (let i = 0; i <= compact.length - 13; i++) {
    const sub = compact.slice(i, i + 13);
    if (sub.startsWith('890')) found.add(sub);
  }

  const candidates = text.match(/\b(\d[\d\s]{10,18}\d)\b/g) || [];
  for (const raw of candidates) {
    const digits = raw.replace(/\s/g, '');
    if (isPlausibleBarcode(digits)) found.add(digits);
  }

  const list = [...found];
  if (!list.length) return null;
  return (
    list.find((b) => b.length === 13 && b.startsWith('890')) ||
    list.find((b) => b.length === 13) ||
    list.sort((a, b) => b.length - a.length)[0]
  );
}

/**
 * @param {string} text
 * @returns {string}
 */
export function extractIngredientsFromOcr(text) {
  const lower = text.toLowerCase();
  let start = lower.indexOf('ingredients');
  let skipLen = 'ingredients'.length;

  if (start === -1) {
    const alt = lower.search(
      /instant\s+noodles\s+with\s+seasoning|noodles\s*:\s*|masala\s*\*?\s*tastemaker/i
    );
    if (alt >= 0) {
      start = alt;
      skipLen = 0;
    }
  }

  if (start === -1) return '';

  let rest = text.slice(start + skipLen).replace(/^[\s:：*]+/, '');
  const stop = rest.search(
    /allergen|nutrition(?:al)?\s*information|store\s*in|customer\s*care|fssai|net\s*quantity|let'?s\s*talk|legal\s+disclaimer|warnings?\b|directions?\s+before|per\s*100\s*g/i
  );
  if (stop > 0) rest = rest.slice(0, stop);
  return rest.replace(/\s+/g, ' ').trim().slice(0, 2500);
}

/**
 * @param {Record<string, unknown> | null | undefined} nutrition
 */
export function nutritionFieldCount(nutrition) {
  if (!nutrition) return 0;
  return Object.keys(nutrition).filter(
    (k) => !k.startsWith('_') && k !== 'per' && k !== 'pack_weight_g' && nutrition[k] != null
  ).length;
}
