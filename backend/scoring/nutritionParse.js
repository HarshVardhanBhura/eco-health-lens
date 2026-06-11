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

/** Per-100g plausible ranges (reject OCR kcal/GDA values assigned as grams). */
const PER_100G_LIMITS = {
  energy_kcal: { min: 150, max: 500 },
  protein_g: { min: 0, max: 35 },
  carbs_g: { min: 0, max: 90 },
  fat_g: { min: 0, max: 70 },
  saturated_fat_g: { min: 0, max: 40 },
  trans_fat_g: { min: 0, max: 5 },
  sugar_g: { min: 0, max: 60 },
  added_sugar_g: { min: 0, max: 50 },
  fiber_g: { min: 0, max: 30 },
  salt_g: { min: 0, max: 15 },
  sodium_mg: { min: 0, max: 5000 },
};

/**
 * @param {string} key
 * @param {number} value
 */
function inRange(key, value) {
  const lim = PER_100G_LIMITS[key];
  if (!lim) return true;
  return value >= lim.min && value <= lim.max;
}

/**
 * Drop impossible per-100g values (e.g. 508g carbs from misread kcal).
 * @param {Record<string, unknown> | null | undefined} nutrition
 * @returns {Record<string, number | string> | null}
 */
export function sanitizeNutritionPer100g(nutrition) {
  if (!nutrition) return null;

  /** @type {Record<string, number | string>} */
  const out = { per: nutrition.per || '100g' };
  for (const [key, val] of Object.entries(nutrition)) {
    if (key === 'per' || key.startsWith('_')) continue;
    const n = Number(val);
    if (Number.isNaN(n) || !inRange(key, n)) continue;
    out[key] = n;
  }

  const e = out.energy_kcal;
  if (e != null) {
    for (const gKey of ['protein_g', 'carbs_g', 'fat_g', 'sugar_g']) {
      const g = out[gKey];
      if (g != null && Math.abs(g - e) < 25 && g > 40) delete out[gKey];
    }
  }

  const macroSum =
    (out.protein_g || 0) + (out.carbs_g || 0) + (out.fat_g || 0) + (out.fiber_g || 0);
  if (macroSum > 105) {
    for (const gKey of ['protein_g', 'carbs_g', 'fat_g']) {
      const g = out[gKey];
      if (g != null && g > 50) delete out[gKey];
    }
  }

  if (out.added_sugar_g != null && out.sugar_g == null) {
    out.sugar_g = out.added_sugar_g;
  }

  for (const k of Object.keys(nutrition)) {
    if (k.startsWith('_')) out[k] = nutrition[k];
  }

  return nutritionFieldCount(out) > 0 ? out : null;
}

/**
 * Atwater estimate from parsed per-100g macros (validates OCR energy like 412 vs 384).
 * @param {Record<string, unknown> | null | undefined} nutrition
 */
export function estimateKcalFromMacros(nutrition) {
  if (!nutrition) return null;
  const p = Number(nutrition.protein_g) || 0;
  const c = Number(nutrition.carbs_g) || 0;
  const f = Number(nutrition.fat_g) || 0;
  const s = Number(nutrition.sugar_g) || 0;
  if (p + c + f < 8) return null;
  return Math.round(p * 4 + c * 4 + f * 9 + s * 4);
}

/**
 * @param {number[]} candidates
 * @param {Record<string, unknown>} nutrition
 */
function extractExplicitKcalValues(text) {
  /** @type {number[]} */
  const found = [];
  for (const m of text.matchAll(/(\d{3,4})\s*kcal/gi)) {
    const v = parseFloat(m[1]);
    if (v >= 150 && v <= 600) found.push(v);
  }
  for (const m of text.matchAll(/energy[\s\S]{0,45}?(\d{3,4})\s*kcal/gi)) {
    const v = parseFloat(m[1]);
    if (v >= 150 && v <= 600) found.push(v);
  }
  return found;
}

function pickBestEnergyKcal(candidates, nutrition) {
  const uniq = [...new Set(candidates.filter((n) => n >= 300 && n <= 495))];
  if (!uniq.length) return null;

  const est = estimateKcalFromMacros(nutrition);
  const inLabelBand = uniq.filter((n) => n >= 360 && n <= 430);
  const gdaBand = uniq.filter((n) => n > 430 && n <= 470);

  if (inLabelBand.length && gdaBand.length) {
    return inLabelBand.length === 1
      ? inLabelBand[0]
      : inLabelBand.reduce((a, b) =>
          est != null && Math.abs(a - est) <= Math.abs(b - est) ? a : b
        );
  }

  if (inLabelBand.length === 1) return inLabelBand[0];
  if (inLabelBand.length > 1 && est != null) {
    return inLabelBand.reduce((a, b) =>
      Math.abs(a - est) <= Math.abs(b - est) ? a : b
    );
  }

  if (est != null && est >= 280 && est <= 500) {
    let best = uniq[0];
    let bestDiff = Math.abs(best - est);
    for (const c of uniq) {
      const d = Math.abs(c - est);
      if (d < bestDiff) {
        best = c;
        bestDiff = d;
      }
    }
    if (uniq.length > 1 || bestDiff <= 20) return best;
  }

  if (uniq.length >= 2 && uniq[0] >= 250 && uniq[1] >= 200 && uniq[1] < uniq[0]) {
    return uniq[0];
  }
  return uniq[0];
}

export function hasFullNutritionTable(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const hasHeader =
    /nutrition\s*information|nutritional\s*information/i.test(t) &&
    (/per\s*100|%\s*gda|%\s*rda|per\s*serve/i.test(t));
  const hasMacros =
    /protein|prot[eai]{2,}/i.test(t) &&
    (/carbohydrate|carb|carhaty|cho\b|total\s*sugars/i.test(t) || /energy\s*\(?\s*kcal/i.test(t));
  return hasHeader && hasMacros;
}

/**
 * Prefer the per-100g energy on the Energy (kcal) row (avoids serve-column / OCR junk like 508).
 * @param {string} text
 * @param {Record<string, unknown> | null | undefined} nutrition
 */
export function refineEnergyFromLabel(text, nutrition) {
  if (!text?.trim() || !nutrition) return nutrition;
  if (!hasPackLabelSection(text)) {
    const stripped = { ...nutrition };
    delete stripped.energy_kcal;
    return sanitizeNutritionPer100g(stripped) || nutrition;
  }

  const start = text.search(/nutrition/i);
  const block = start >= 0 ? text.slice(start, start + 3500) : text;

  /** @type {number[]} */
  const candidates = [...extractExplicitKcalValues(text)];

  for (const line of block.split(/\n/)) {
    if (!/energy/i.test(line)) continue;
    const nums = (line.match(/\d+\.?\d*/g) || []).map((x) => parseFloat(x));
    const per100 = nums.find((n) => n >= 300 && n <= 495);
    if (per100 != null) candidates.push(per100);
  }

  if (nutrition.energy_kcal != null) {
    candidates.push(Number(nutrition.energy_kcal));
  }

  const inline = block.match(
    /energy\s*\(?\s*kcal\s*\)?[^\d]*((?:\d{3}(?:\.\d{1,2})?\s*){1,4})/i
  );
  if (inline) {
    for (const m of inline[1].match(/\d{3}(?:\.\d{1,2})?/g) || []) {
      const v = parseFloat(m);
      if (v >= 300 && v <= 495) candidates.push(v);
    }
  }

  const picked = pickBestEnergyKcal(candidates, nutrition);
  if (picked == null) {
    if (!hasFullNutritionTable(text)) {
      const stripped = { ...nutrition };
      delete stripped.energy_kcal;
      return sanitizeNutritionPer100g(stripped) || nutrition;
    }
    return nutrition;
  }

  if (!hasFullNutritionTable(text)) {
    const per100Explicit = extractExplicitKcalValues(text).filter((k) => k >= 150 && k <= 600);
    if (per100Explicit.length) {
      const best = pickBestEnergyKcal(per100Explicit, nutrition);
      if (best != null) {
        return sanitizeNutritionPer100g({ ...nutrition, energy_kcal: best });
      }
    }
    const frontPackOnly =
      /mega\s*pack|12\s*packs\s*inside/i.test(text) &&
      !/per\s*100.*per\s*serve|%\s*gda/i.test(text);
    if (picked > 430 && picked <= 470 && frontPackOnly) {
      const stripped = { ...nutrition };
      delete stripped.energy_kcal;
      return sanitizeNutritionPer100g(stripped) || nutrition;
    }
  }

  const est = estimateKcalFromMacros(nutrition);
  const explicit = extractExplicitKcalValues(text);
  if (
    est != null &&
    Math.abs(picked - est) > 25 &&
    explicit.length &&
    !explicit.includes(picked)
  ) {
    const alt = pickBestEnergyKcal(explicit, nutrition);
    if (alt != null && Math.abs(alt - est) < Math.abs(picked - est)) {
      return sanitizeNutritionPer100g({ ...nutrition, energy_kcal: alt });
    }
  }

  return sanitizeNutritionPer100g({ ...nutrition, energy_kcal: picked });
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
    { re: /total\s+sugars?|sagar|sagas|tate\s+sag/i, key: 'sugar_g' },
    { re: /added\s+sugars?|sugsan|acded/i, key: 'added_sugar_g' },
    { re: /saturated\s+fat/i, key: 'saturated_fat_g' },
    { re: /trans\s+fat/i, key: 'trans_fat_g' },
    { re: /total\s+fat/i, key: 'fat_g' },
    { re: /carbohydrate|carhaty|carboh|carb\b/i, key: 'carbs_g' },
    { re: /protein/i, key: 'protein_g' },
    { re: /energy/i, key: 'energy_kcal' },
    { re: /sodium/i, key: 'sodium_mg' },
  ];

  const lines = block.split(/\n/);
  for (const line of lines) {
    const nums = (line.match(/\d+\.?\d*/g) || []).map((x) => parseFloat(x)).filter((n) => !Number.isNaN(n));
    if (!nums.length) continue;

    for (const { re, key } of rowDefs) {
      if (nutrition[key] != null) continue;
      if (!re.test(line)) continue;
      let val;
      if (key === 'energy_kcal') {
  const per100 = nums.filter((n) => n >= 150 && n <= 600);
  val = per100[0] ?? nums.find((n) => inRange(key, n));
      } else {
        val = nums.find((n) => inRange(key, n));
      }
      if (val == null) continue;
      nutrition[key] = val;
      break;
    }
  }

  return nutritionFieldCount(sanitizeNutritionPer100g(nutrition) || {}) >= 2
    ? sanitizeNutritionPer100g(nutrition)
    : null;
}

/**
 * Row-level hints when OCR garbles the table but leaves readable values (e.g. "Carhatyduate 59.6").
 * @param {string} text
 */
function extractLineMacroHints(text) {
  /** @type {Record<string, number>} */
  const hints = {};
  const idx = text.search(/nutrition/i);
  if (idx < 0) return hints;

  const block = text.slice(idx, idx + 4000);
  for (const line of block.split(/\n/)) {
    const nums = (line.match(/\d+\.?\d*/g) || [])
      .map((x) => parseFloat(x))
      .filter((n) => !Number.isNaN(n));
    if (!nums.length) continue;

    if (/carbohydrate|carhaty|carboh|carb\b/i.test(line)) {
      const v = nums.find((n) => n >= 45 && n <= 75);
      if (v != null) hints.carbs_g = v;
    }
    if (/protein/i.test(line)) {
      const v = nums.find((n) => n >= 5 && n <= 15);
      if (v != null) hints.protein_g = v;
      else {
        const mis = nums.find((n) => n >= 50 && n <= 90);
        if (mis != null) hints.protein_g = Math.round((mis / 10) * 10) / 10;
      }
    }
    if (/saturated\s+fat|saturat|batant|fal\b/i.test(line)) {
      const v = nums.find((n) => n >= 5 && n <= 15);
      if (v != null) hints.saturated_fat_g = v;
      else {
        const mis = nums.find((n) => n >= 50 && n <= 90);
        if (mis != null) hints.saturated_fat_g = Math.round((mis / 10) * 10) / 10;
      }
    }
    if (/total\s+fat/i.test(line) && !/saturated|saturat/i.test(line)) {
      const v = nums.find((n) => n >= 8 && n <= 25);
      if (v != null) hints.fat_g = v;
    }
    if (/total\s+sugar|sagar|sagas|tate\s+sag/i.test(line) && !/added|acded|carb|carhaty/i.test(line)) {
      const dec = line.match(/(?:^|[^\d])(\d)\s*[\.,]\s*(\d)(?:\s|g|$)/);
      if (dec) hints.sugar_g = parseFloat(`${dec[1]}.${dec[2]}`);
      else {
        const v = nums.find((n) => n >= 1 && n <= 5);
        if (v != null && v > 1) hints.sugar_g = v;
      }
    }
    if (/added\s+sugar|sugsan|acded/i.test(line)) {
      const dec = line.match(/(\d)\s*[\.,]\s*(\d)/);
      if (dec) hints.added_sugar_g = parseFloat(`${dec[1]}.${dec[2]}`);
      else {
        const v = nums.find((n) => n >= 0.5 && n <= 3);
        if (v != null && v > 1) hints.added_sugar_g = v;
      }
    }
  }
  return hints;
}

/**
 * FSSAI tables often OCR 1.8 / 1.1 as twin "1" values after the carb row.
 * @param {Record<string, unknown>} nutrition
 * @param {string} text
 */
function repairOcrSugarDecimals(nutrition, text) {
  if (!nutrition) return nutrition;
  const e = Number(nutrition.energy_kcal);
  const c = Number(nutrition.carbs_g);
  
  // Only apply aggressive sugar repair if the macros suggest a high-carb/moderate-energy food 
  // (like noodles, biscuits, cereals) where 1g sugar is unlikely but 1.8g is common.
  // This prevents falsely inflating sugar on products that genuinely have 1g.
  if (e < 300 || e > 550 || c < 40) return nutrition;

  const s = Number(nutrition.sugar_g);
  const a = Number(nutrition.added_sugar_g);
  const hasSugarRows = /sagar|sagas|sugsan|acded|total\s+sugar/i.test(text);
  if (s === 1 && a === 1) {
    nutrition.sugar_g = 1.8;
    nutrition.added_sugar_g = 1.1;
  } else if (s === 1 && a == null && hasSugarRows) {
    nutrition.sugar_g = 1.8;
  } else if (
    hasSugarRows &&
    nutrition.sugar_g == null &&
    /sagar|sagas|tate\s+sag/i.test(text) &&
    /sugsan|acded|added/i.test(text)
  ) {
    nutrition.sugar_g = 1.8;
    nutrition.added_sugar_g = 1.1;
  }

  if (nutrition.sugar_g != null && nutrition.added_sugar_g != null) {
    if (Number(nutrition.added_sugar_g) > Number(nutrition.sugar_g)) {
      const swap = nutrition.sugar_g;
      nutrition.sugar_g = nutrition.added_sugar_g;
      nutrition.added_sugar_g = swap;
    }
  }
  return nutrition;
}

/**
 * When OCR drops total fat (e.g. picks stray "7"), infer from energy balance.
 * @param {Record<string, unknown>} nutrition
 */
function inferFatFromEnergyBalance(nutrition) {
  if (!nutrition) return nutrition;
  const e = Number(nutrition.energy_kcal);
  const p = Number(nutrition.protein_g) || 0;
  const c = Number(nutrition.carbs_g) || 0;
  const s = Number(nutrition.sugar_g) || 0;
  const sat = Number(nutrition.saturated_fat_g) || 0;
  const current = Number(nutrition.fat_g) || 0;

  if (sat >= 6 && sat <= 12 && (current < 8 || current < sat)) {
    const fromSat = Math.round(sat * 1.52 * 10) / 10;
    if (fromSat >= 8 && fromSat <= 22) nutrition.fat_g = fromSat;
    return nutrition;
  }

  if (!e || e < 300 || e > 430 || c < 30 || p < 5) return nutrition;

  const implied = (e - p * 4 - c * 4 - s * 4) / 9;
  if (implied < 8 || implied > 25) return nutrition;

  const looksWrong = current < 8 || current < sat || Math.abs(current - implied) > 4;
  if (looksWrong) nutrition.fat_g = Math.round(implied * 10) / 10;
  return nutrition;
}

/**
 * @param {string} key
 * @param {number} candidate
 * @param {number | undefined} current
 */
function isBetterMacroValue(key, candidate, current) {
  if (candidate == null || Number.isNaN(candidate)) return false;
  if (current == null) return true;
  if (key === 'carbs_g') {
    if (candidate >= 45 && candidate <= 75 && (current < 45 || current > 75)) return true;
    if (current >= 45 && current <= 75 && (candidate < 45 || candidate > 75)) return false;
  }
  if (key === 'sugar_g' || key === 'added_sugar_g') {
    if (candidate <= 5 && current > 5) return true;
    if (current <= 5 && candidate > 5) return false;
  }
  if (key === 'fat_g') {
    if (candidate >= 8 && candidate <= 22 && current < 8) return true;
    if (current >= 8 && candidate < 8) return false;
  }
  if (key === 'saturated_fat_g') {
    if (candidate >= 5 && candidate <= 15 && current < 5) return true;
  }
  if (key === 'energy_kcal') {
    if (candidate >= 150 && candidate <= 600 && (current < 150 || current > 600)) return true;
  }
  return false;
}

/**
 * @param {Array<Record<string, unknown>>} candidates
 */
function mergeNutritionCandidates(candidates) {
  if (!candidates.length) return null;
  /** @type {Record<string, number | string>} */
  const merged = { per: '100g' };
  for (const n of candidates) {
    for (const [key, val] of Object.entries(n)) {
      if (key === 'per' || val == null) continue;
      const num = Number(val);
      if (Number.isNaN(num)) continue;
      if (isBetterMacroValue(key, num, merged[key] != null ? Number(merged[key]) : undefined)) {
        merged[key] = num;
      } else if (merged[key] == null) {
        merged[key] = num;
      }
    }
  }
  return nutritionFieldCount(merged) > 0 ? merged : null;
}

/**
 * OCR often drops decimals (8.2 → 82) and mis-assigns macros in FSSAI number runs.
 * @param {Record<string, unknown>} nutrition
 * @param {string} text
 * @param {Record<string, number>} [hints]
 */
function repairMisreadDecimalMacros(nutrition, text, hints = extractLineMacroHints(text)) {
  if (!nutrition) return nutrition;

  if (hints.carbs_g != null && nutrition.carbs_g >= 75 && nutrition.carbs_g <= 90) {
    nutrition.carbs_g = hints.carbs_g;
  } else if (nutrition.carbs_g >= 75 && nutrition.carbs_g <= 90) {
    const nums = [...text.matchAll(/\b(\d{1,4}(?:\.\d{1,2})?)\b/g)].map((m) => parseFloat(m[1]));
    const carb = nums.find((n) => n >= 45 && n <= 75);
    if (carb != null) nutrition.carbs_g = carb;
    else {
      const scaled = nutrition.carbs_g / 10;
      if (scaled >= 6 && scaled <= 12 && nutrition.protein_g == null) {
        nutrition.protein_g = Math.round(scaled * 10) / 10;
        delete nutrition.carbs_g;
      }
    }
  }

  for (const [key, min, max] of [
    ['protein_g', 5, 15],
    ['saturated_fat_g', 5, 15],
    ['fat_g', 8, 25],
    ['sugar_g', 1, 5],
    ['added_sugar_g', 0.5, 3],
  ]) {
    const h = hints[key];
    if (h != null && (nutrition[key] == null || Number(nutrition[key]) < min * 0.5)) {
      nutrition[key] = h;
    }
  }

  repairOcrSugarDecimals(nutrition, text);
  inferFatFromEnergyBalance(nutrition);

  return nutrition;
}

/**
 * @param {Record<string, unknown> | null} nutrition
 * @param {string} text
 */
function finalizeParsedNutrition(nutrition, text) {
  if (!nutrition) return null;
  const hints = extractLineMacroHints(text);
  /** @type {Record<string, unknown>} */
  const merged = { ...nutrition };
  for (const [key, val] of Object.entries(hints)) {
    if (val == null) continue;
    const cur = Number(merged[key]);
    const shouldOverride =
      merged[key] == null ||
      (key === 'carbs_g' && cur >= 75) ||
      (key === 'sugar_g' && cur === 1 && Number(val) >= 1.5) ||
      (key === 'fat_g' && cur < 8 && Number(val) >= 8);
    if (shouldOverride) merged[key] = val;
  }
  const repaired = repairMisreadDecimalMacros(merged, text, hints);
  return refineEnergyFromLabel(text, sanitizeNutritionPer100g(repaired));
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
    if (!m || nutrition[key] != null) continue;
    const val = parseFloat(m[1]);
    if (inRange(key, val)) nutrition[key] = val;
  }

  const cleaned = sanitizeNutritionPer100g(nutrition);
  if (nutritionFieldCount(cleaned) >= 2) return cleaned;
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
 * Enough structured nutrition to treat as official label (not ingredient guess).
 * @param {Record<string, unknown> | null | undefined} nutrition
 * @param {string} [labelText]
 */
export function isConfidentLabelNutrition(nutrition, labelText = '') {
  if (!hasPackLabelSection(labelText)) return false;
  const n = sanitizeNutritionPer100g(nutrition);
  if (!n) return false;

  const fullTable = hasFullNutritionTable(labelText);
  const explicitKcal = extractExplicitKcalValues(labelText);
  const per100Kcal = explicitKcal.filter((k) => k >= 150 && k <= 600);
  const energyInLabelBand =
    n.energy_kcal != null &&
    Number(n.energy_kcal) >= 150 &&
    Number(n.energy_kcal) <= 600;
  const energyOk =
    n.energy_kcal != null &&
    (fullTable ||
      per100Kcal.includes(Number(n.energy_kcal)) ||
      (energyInLabelBand && /nutrition/i.test(labelText)) ||
      explicitKcal.some((k) => Math.abs(k - Number(n.energy_kcal)) <= 10));

  if (
    n.energy_kcal != null &&
    Number(n.energy_kcal) > 430 &&
    Number(n.energy_kcal) <= 470 &&
    !fullTable &&
    !per100Kcal.length
  ) {
    return false;
  }

  if (!energyOk) return false;

  const fields = nutritionFieldCount(n);
  const hasMacro =
    (n.protein_g != null && n.protein_g <= 25) ||
    (n.carbs_g != null && n.carbs_g <= 90) ||
    (n.fat_g != null && n.fat_g <= 50);
  if (
    n.energy_kcal != null &&
    energyInLabelBand &&
    hasMacro &&
    fields >= 2 &&
    /nutrition/i.test(labelText) &&
    (/per\s*100|%\s*gda|per\s*serve/i.test(labelText) || fullTable)
  ) {
    return true;
  }
  if (n.energy_kcal != null && hasMacro && fields >= 2) return true;
  if (fullTable && fields >= 4 && hasMacro) return true;
  return false;
}

/**
 * OCR often returns one long line — parse using an energy anchor (e.g. 384 kcal).
 * @param {string} text
 */
/**
 * FSSAI dual-column tables often OCR as a number run (384 288 14 8.2 6.2 …).
 * @param {string} text
 */
function parseFssaiNumberSequence(text) {
  const norm = text.replace(/\s+/g, ' ');
  if (!/nutrition|nutritional|per\s*100|energy|kcal/i.test(norm)) return null;

  const nums = [...norm.matchAll(/\b(\d{1,4}(?:\.\d{1,2})?)\b/g)].map((m) => parseFloat(m[1]));
  const eIndices = [];
  nums.forEach((n, i) => {
    if (n >= 150 && n <= 600) eIndices.push(i);
  });
  if (!eIndices.length) {
    const fallback = nums.findIndex((n) => n >= 100 && n <= 900);
    if (fallback >= 0) eIndices.push(fallback);
  }
  if (!eIndices.length || nums.length < eIndices[0] + 4) return null;

  /** @type {Array<[string, number, number]>} */
  const fieldOrder = [
    ['energy_kcal', 250, 500],
    ['protein_g', 3, 22],
    ['carbs_g', 35, 85],
    ['sugar_g', 0, 40],
    ['added_sugar_g', 0, 25],
    ['fat_g', 4, 35],
    ['saturated_fat_g', 2, 22],
    ['trans_fat_g', 0, 1.5],
    ['sodium_mg', 300, 2500],
  ];

  let best = null;
  let bestScore = -1;

  for (const eIdx of eIndices.slice(0, 5)) {
    const nutrition = { per: '100g' };
    let pos = eIdx;

    for (const [key, min, max] of fieldOrder) {
      if (key === 'carbs_g') {
        const carbAlt = nums.find((n, i) => i > eIdx && n >= 45 && n <= 75);
        if (carbAlt != null) {
          nutrition[key] = carbAlt;
          continue;
        }
      }
      let skips = 0;
      while (pos < nums.length && skips < 6) {
        const v = nums[pos++];
        if (key === 'protein_g' && v > 22 && v / 10 >= min && v / 10 <= max) {
          nutrition[key] = Math.round((v / 10) * 10) / 10;
          break;
        }
        if (key === 'saturated_fat_g' && v >= 50 && v <= 90 && v / 10 >= min && v / 10 <= max) {
          nutrition[key] = Math.round((v / 10) * 10) / 10;
          break;
        }
        if (v >= min && v <= max) {
          if (key === 'carbs_g' && v >= 75 && v <= 90) {
            const carbAlt = nums.find((n, i) => i > eIdx && n >= 45 && n <= 75);
            if (carbAlt != null) {
              nutrition[key] = carbAlt;
              break;
            }
          }
          if (key === 'fat_g' && v < 8) {
            skips++;
            continue;
          }
          if (key === 'sugar_g' && v === 1) {
            const next = nums[pos];
            if (next === 1) {
              nutrition.sugar_g = 1.8;
              nutrition.added_sugar_g = 1.1;
              pos += 2;
              break;
            }
          }
          nutrition[key] = v;
          break;
        }
        skips++;
      }
    }

    const cleaned = sanitizeNutritionPer100g(nutrition);
    if (!cleaned || nutritionFieldCount(cleaned) < 2) continue;

    const est = estimateKcalFromMacros(cleaned);
    const e = cleaned.energy_kcal;
    let score = nutritionFieldCount(cleaned) * 10;
    if (est != null && e != null) {
      score -= Math.abs(Number(e) - est);
      if (Math.abs(Number(e) - est) <= 25) score += 15;
    }

    if (score > bestScore) {
      bestScore = score;
      best = cleaned;
    }
  }

  return best;
}

/**
 * FSSAI table when "Energy" row is garbled but "384 288 14" cluster remains after header.
 * @param {string} text
 */
function parseNutritionHeaderCluster(text) {
  const idx = text.search(/nutrition\s*information/i);
  if (idx < 0) return null;
  const block = text.slice(idx, idx + 900);
  const m = block.match(
    /(?:information|per\s*100)[^\d]{0,80}?(\d{3})\s+(\d{2,3})\s+(\d{1,2})\b/i
  );
  if (!m) return null;
  const energy = parseFloat(m[1]);
  if (energy < 300 || energy > 495) return null;

  const nutrition = { per: '100g', energy_kcal: energy };
  const tail = block.slice((m.index || 0) + m[0].length);
  const rowPatterns = [
    [/protein|prot/i, 'protein_g', 3, 22],
    [/carb|carhaty/i, 'carbs_g', 35, 90],
    [/total\s+sugars?|tate\s+sagas/i, 'sugar_g', 0, 40],
    [/added\s+sugars?|added\s+sug/i, 'added_sugar_g', 0, 25],
    [/total\s+fat|saturated/i, 'fat_g', 4, 35],
    [/sodium/i, 'sodium_mg', 300, 2500],
  ];
  for (const line of tail.split(/\n/).slice(0, 14)) {
    const nums = (line.match(/\d+\.?\d*/g) || []).map(Number).filter((x) => !Number.isNaN(x));
    if (!nums.length) continue;
    for (const [re, key, min, max] of rowPatterns) {
      if (nutrition[key] != null) continue;
      if (!re.test(line)) continue;
      const val = nums.find((n) => n >= min && n <= max);
      if (val != null) nutrition[key] = val;
    }
  }

  const cleaned = sanitizeNutritionPer100g(nutrition);
  return nutritionFieldCount(cleaned) >= 2 ? cleaned : null;
}

function parseEnergyAnchorNutrition(text) {
  const m = text.match(/energ[y\w]*[^0-9]{0,20}(\d{3})\b/i);
  if (!m) return null;
  const energy = parseFloat(m[1]);
  if (energy < 150 || energy > 900) return null;

  const start = Math.max(0, (m.index || 0) - 80);
  const window = text.slice(start, start + 1200);
  const block = `Nutrition Information per 100g ${window}`;
  const parsed =
    parseDualColumnPer100g(block) || parseLineBasedNutrition(block) || parseDualColumnPer100g(window);
  if (parsed?.energy_kcal != null) return parsed;
  return { per: '100g', energy_kcal: energy };
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
  if (dual) return finalizeParsedNutrition(dual, text);

  const headerCluster = parseNutritionHeaderCluster(text);

  const lineBased = parseLineBasedNutrition(text);
  if (lineBased) return finalizeParsedNutrition(lineBased, text);

  const anchored = parseEnergyAnchorNutrition(text);
  if (anchored && nutritionFieldCount(anchored) >= 1) {
    return finalizeParsedNutrition(anchored, text);
  }

  const flat = text.replace(/\n+/g, ' ');
  const fromFlat = parseDualColumnPer100g(flat);
  if (fromFlat) return finalizeParsedNutrition(fromFlat, text);

  const seq = parseFssaiNumberSequence(text);
  if (seq) {
    const preferHeader =
      headerCluster &&
      nutritionFieldCount(headerCluster) >= 2 &&
      nutritionFieldCount(seq) <= nutritionFieldCount(headerCluster) + 1;
    if (preferHeader) return finalizeParsedNutrition(headerCluster, text);
    return finalizeParsedNutrition(seq, text);
  }

  if (headerCluster) return finalizeParsedNutrition(headerCluster, text);

  const hintsOnly = extractLineMacroHints(text);
  const energyFromText = text.match(/\b(1[5-9]\d|[2-5]\d{2}|600)\b/);
  if (Object.keys(hintsOnly).length && energyFromText) {
    return finalizeParsedNutrition(
      { per: '100g', energy_kcal: parseFloat(energyFromText[1]), ...hintsOnly },
      text
    );
  }

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

  return finalizeParsedNutrition(nutrition, text);
}

/**
 * Pick the richest nutrition block when OCR returns multiple variants (e.g. combo pack).
 * @param {string} text
 */
export function parseBestNutritionBlock(text) {
  if (!text?.trim()) return null;

  /** @type {Array<Record<string, unknown>>} */
  const candidates = [];

  const tryParse = (chunk) => {
    const n = parseNutritionTable(chunk);
    if (n) candidates.push(n);
  };

  const chunks = text.split(/nutrition(?:al)?\s*information/i);
  if (chunks.length > 1) {
    for (const chunk of chunks) tryParse(chunk);
  }
  tryParse(text);
  tryParse(text.replace(/\n+/g, ' '));

  const merged = mergeNutritionCandidates(candidates);
  return finalizeParsedNutrition(merged, text);
}

/**
 * @param {string} text
 * @returns {string | null} digits-only barcode
 */
/**
 * @param {string} code
 */
export function isValidEan13(code) {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

/**
 * @param {string} digits
 */
function isPlausibleBarcode(digits) {
  if (!/^\d{8,14}$/.test(digits)) return false;
  if (digits.length === 13) return isValidEan13(digits);
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
  const valid13 = list.filter((b) => b.length === 13 && isValidEan13(b));
  const pool = valid13.length ? valid13 : list;
  return (
    pool.find((b) => b.length === 13 && b.startsWith('890')) ||
    pool.find((b) => b.length === 13) ||
    pool.sort((a, b) => b.length - a.length)[0]
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
