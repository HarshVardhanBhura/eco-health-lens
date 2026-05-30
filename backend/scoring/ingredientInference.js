/**
 * Estimate per-100g nutrition from a detailed ingredient list (with % where listed).
 * Used when Amazon does not expose a parseable nutrition table.
 */

/**
 * @param {string} text
 */
export function hasRichIngredientList(text) {
  const t = (text || '').trim();
  if (t.length < 50) return false;
  const parts = t.split(/[,;]/).map((p) => p.trim()).filter((p) => p.length > 2);
  if (parts.length < 4) return false;
  const hasPercent = /\(\s*\d+(?:\.\d+)?\s*%/.test(t);
  const hasSugarOrCocoa = /\bsugar\b|cocoa|emulsifier|milk solids/i.test(t);
  return hasPercent || (parts.length >= 6 && hasSugarOrCocoa);
}

/**
 * @param {string} ingredientsText
 * @returns {Array<{ name: string, percent: number | null }>}
 */
export function parseIngredientParts(ingredientsText) {
  const main = ingredientsText.split(/allergen/i)[0].trim();
  const parts = main.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  return parts.map((part) => {
    const pct = part.match(/\(\s*(\d+(?:\.\d+)?)\s*%\s*\*?\s*\)/i);
    const name = part.replace(/\(\s*\d+(?:\.\d+)?\s*%\s*\*?\s*\)/gi, '').trim().toLowerCase();
    return { name, percent: pct ? parseFloat(pct[1]) : null };
  });
}

/**
 * @param {Array<{ name: string, percent: number | null }>} parts
 * @returns {Record<string, number> | null}
 */
function estimatePer100g(parts) {
  if (!parts.length) return null;

  let sugarPct = 0;
  let fatPct = 0;
  let carbsPct = 0;
  let proteinPct = 0;
  let accounted = 0;

  for (let i = 0; i < parts.length; i++) {
    const { name, percent } = parts[i];
    if (percent == null) continue;
    accounted += percent;

    if (/^sugar\b/.test(name) || name === 'sugar') sugarPct += percent;
    else if (/cocoa butter|butteroil/.test(name)) fatPct += percent * 0.99;
    else if (/cocoa solid|cacao/.test(name)) fatPct += percent * 0.55;
    else if (/milk solid|milk powder|skim milk/.test(name)) {
      fatPct += percent * 0.25;
      sugarPct += percent * 0.4;
      proteinPct += percent * 0.2;
    } else if (/raisin|cashew|apricot|nut|almond|hazelnut|fruit/.test(name)) {
      carbsPct += percent * 0.7;
      sugarPct += percent * 0.15;
      proteinPct += percent * 0.08;
    } else if (/wheat|flour|oat|rice|starch|maltodextrin/.test(name)) carbsPct += percent * 0.75;
    else if (/oil|ghee|palm|hydrogenated/.test(name)) fatPct += percent * 0.9;
    else if (/salt|sodium/.test(name)) {
      /* trace */
    } else if (/protein|whey|soy/.test(name)) proteinPct += percent * 0.8;
  }

  const first = parts[0];
  if (first && /^sugar\b/.test(first.name) && first.percent == null && accounted < 95) {
    sugarPct += Math.max(0, 100 - accounted) * 0.85;
    accounted = Math.min(100, accounted + (100 - accounted) * 0.85);
  } else if (accounted < 92) {
    const remainder = 100 - accounted;
    if (/chocolate|cocoa|biscuit|cookie|snack/.test(parts.map((p) => p.name).join(' '))) {
      sugarPct += remainder * 0.5;
      fatPct += remainder * 0.35;
    } else {
      carbsPct += remainder * 0.4;
      sugarPct += remainder * 0.2;
    }
  }

  const sugar_g = Math.round(Math.min(85, sugarPct) * 10) / 10;
  const fat_g = Math.round(Math.min(70, fatPct) * 10) / 10;
  const carbs_g = Math.round(Math.min(80, carbsPct + sugarPct * 0.15) * 10) / 10;
  const protein_g = Math.round(Math.min(25, proteinPct + 1.5) * 10) / 10;
  const saturated_fat_g = Math.round(fat_g * 0.55 * 10) / 10;
  const fiber_g = Math.round(Math.min(15, carbsPct * 0.1) * 10) / 10;
  const energy_kcal = Math.round(sugar_g * 4 + fat_g * 9 + carbs_g * 4 + protein_g * 4);

  if (sugar_g + fat_g + carbs_g < 8) return null;

  return {
    per: '100g',
    sugar_g,
    fat_g,
    saturated_fat_g,
    carbs_g,
    protein_g,
    fiber_g,
    energy_kcal,
    _inferred: true,
  };
}

/**
 * @param {string} ingredientsText
 * @param {number | undefined} packWeightG
 */
export function inferNutritionFromIngredients(ingredientsText, packWeightG) {
  if (!hasRichIngredientList(ingredientsText)) return null;
  const parts = parseIngredientParts(ingredientsText);
  const est = estimatePer100g(parts);
  if (!est) return null;
  if (packWeightG) est.pack_weight_g = packWeightG;
  return est;
}
