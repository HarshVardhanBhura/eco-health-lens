import { isConfidentLabelNutrition, sanitizeNutritionPer100g } from './nutritionParse.js';

const DAILY_REF = {
  protein_g: 50,
  carbs_g: 275,
  fat_g: 70,
  fiber_g: 25,
  sugar_g: 50,
  salt_g: 6,
  saturated_fat_g: 20,
};

const NUTRISCORE_MAP = { a: 95, b: 80, c: 65, d: 45, e: 25 };

/**
 * @param {number} value
 * @param {number} ref
 * @param {'higher_better' | 'lower_better'} direction
 */
function refPercent(value, ref, direction) {
  if (value == null || ref <= 0) return 0;
  const pct = Math.round((value / ref) * 100);
  if (direction === 'higher_better') return pct;
  return pct;
}

/**
 * @param {number} pct
 * @param {'higher_better' | 'lower_better'} direction
 */
function macroStatus(pct, direction) {
  if (!pct) return 'neutral';
  if (direction === 'higher_better') {
    if (pct >= 15 && pct <= 40) return 'good';
    if (pct > 50) return 'warn';
    return 'neutral';
  }
  if (pct <= 10) return 'good';
  if (pct <= 25) return 'warn';
  return 'bad';
}

/**
 * @param {Record<string, number | string>} nutrition
 */
export function scoreMacros(nutrition) {
  const safe = sanitizeNutritionPer100g(nutrition);
  if (!safe || Object.keys(safe).length <= 1) {
    return { score: 50, items: [] };
  }
  nutrition = safe;

  const defs = [
    { name: 'Energy', key: 'energy_kcal', ref: 2000, dir: 'lower_better', unit: 'kcal' },
    { name: 'Protein', key: 'protein_g', ref: DAILY_REF.protein_g, dir: 'higher_better', unit: 'g' },
    { name: 'Carbs', key: 'carbs_g', ref: DAILY_REF.carbs_g, dir: 'lower_better', unit: 'g' },
    { name: 'Fat', key: 'fat_g', ref: DAILY_REF.fat_g, dir: 'lower_better', unit: 'g' },
    { name: 'Fiber', key: 'fiber_g', ref: DAILY_REF.fiber_g, dir: 'higher_better', unit: 'g' },
    { name: 'Sugar', key: 'sugar_g', ref: DAILY_REF.sugar_g, dir: 'lower_better', unit: 'g' },
    { name: 'Salt', key: 'salt_g', ref: DAILY_REF.salt_g, dir: 'lower_better', unit: 'g' },
  ];

  /** @type {Array<object>} */
  const items = [];
  let total = 0;
  let count = 0;

  for (const d of defs) {
    const value = nutrition[d.key];
    if (value == null) continue;
    const pct = refPercent(Number(value), d.ref, d.dir);
    const status = macroStatus(pct, d.dir);
    items.push({
      name: d.name,
      value: Number(value),
      unit: d.unit || 'g',
      value_g: d.unit === 'g' ? Number(value) : undefined,
      refPercent: pct,
      status,
    });

    let part = 50;
    if (d.dir === 'higher_better') {
      part = status === 'good' ? 85 : status === 'warn' ? 55 : 65;
    } else {
      part = status === 'good' ? 85 : status === 'warn' ? 55 : 35;
    }
    if (d.key === 'sugar_g' && value != null) {
      if (value >= 42) part = 28;
      else if (value >= 36) part = 38;
      else if (value < 28) part = Math.max(part, 72);
    }
    total += part;
    count++;
  }

  const score = count ? Math.round(total / count) : 50;
  return { score, items };
}

/**
 * @param {object} merged
 */
export function scoreProcessing(merged) {
  const nova = merged.nova_group;
  if (nova != null) {
    const map = { 1: 95, 2: 80, 3: 55, 4: 30 };
    return { score: map[nova] ?? 50, nova };
  }

  const text = (merged.ingredientsText || '').toLowerCase();
  if (!text) return { score: 50 };
  let score = 70;
  if (/refined|hydrogenated|instant|artificial|emulsifier/.test(text)) score -= 25;
  if (/whole grain|whole wheat|wholegrain|wholemeal/.test(text)) score += 10;
  return { score: Math.max(20, Math.min(95, score)) };
}

/**
 * @param {string} grade
 */
export function scoreNutriscore(grade) {
  if (!grade) return { score: 50 };
  const g = grade.toLowerCase().charAt(0);
  return { score: NUTRISCORE_MAP[g] ?? 50, grade: g.toUpperCase() };
}

/**
 * @param {object} merged
 * @param {{ score: number, flags: object[] }} additiveResult
 * @param {ReturnType<typeof buildHealthScore>['components']} components
 * @returns {Array<{ text: string, type: 'positive' | 'negative' | 'neutral' }>}
 */
export function buildHealthRationale(merged, additiveResult, components) {
  /** @type {Array<{ text: string, type: 'positive' | 'negative' | 'neutral' }>} */
  const rationale = [];

  if (merged.offEnriched) {
    rationale.push({
      type: 'positive',
      text: 'Nutrition data from Open Food Facts (matched by product barcode).',
    });
  } else if (merged.nutritionInferred) {
    rationale.push({
      type: 'neutral',
      text: 'Nutrition estimated from ingredients — not from an official pack label.',
    });
  } else if (
    merged.nutrition?._fromImage ||
    isConfidentLabelNutrition(merged.nutrition, '')
  ) {
    rationale.push({
      type: 'neutral',
      text: 'Score uses nutrition read from product packaging images.',
    });
  } else if (merged.packLabelRead) {
    rationale.push({
      type: 'neutral',
      text: 'Pack label detected in product images — ingredients from label; nutrition table partially used.',
    });
  }

  const macroItems = components.macros?.items || [];
  const concerns = macroItems
    .filter((i) => i.status === 'bad' || i.status === 'warn')
    .sort((a, b) => (b.refPercent || 0) - (a.refPercent || 0));

  for (const item of concerns.slice(0, 2)) {
    const val =
      item.value != null ? ` (${item.value}${item.unit || 'g'} per 100g)` : '';
    const label = item.name.replace(/\s*\(est\.\)/i, '').toLowerCase();
    if (item.status === 'bad') {
      rationale.push({
        type: 'negative',
        text: `High ${label}${val} — main factor lowering the score`,
      });
    } else {
      rationale.push({
        type: 'negative',
        text: `Elevated ${label}${val}`,
      });
    }
  }

  const positives = macroItems.filter((i) => i.status === 'good').slice(0, 1);
  for (const item of positives) {
    const label = item.name.replace(/\s*\(est\.\)/i, '').toLowerCase();
    rationale.push({ type: 'positive', text: `Favourable ${label} level for a daily diet` });
  }

  const flags = components.additives?.flags || [];
  if (flags.length) {
    const names = [...new Set(flags.slice(0, 3).map((f) => f.name))].join(', ');
    rationale.push({
      type: 'negative',
      text: `Additives flagged: ${names}`,
    });
  } else if ((components.additives?.score ?? 50) >= 75 && (merged.ingredientsText || '').length > 20) {
    rationale.push({
      type: 'positive',
      text: 'No concerning additives detected in the ingredient list',
    });
  }

  if (components.processing?.nova != null) {
    const novaLabels = {
      1: 'minimally processed',
      2: 'processed culinary ingredient',
      3: 'processed food',
      4: 'ultra-processed',
    };
    const label = novaLabels[components.processing.nova] || 'processed';
    rationale.push({
      type: components.processing.score < 55 ? 'negative' : 'neutral',
      text: `Processing: NOVA ${components.processing.nova} (${label})`,
    });
  } else if ((components.processing?.score ?? 50) < 50) {
    rationale.push({
      type: 'negative',
      text: 'Ingredient list suggests a highly processed product',
    });
  }

  if (components.nutriscore?.grade) {
    rationale.push({
      type: (components.nutriscore.score ?? 50) >= 65 ? 'positive' : 'negative',
      text: `Nutri-Score ${components.nutriscore.grade} (reference grade when available)`,
    });
  }

  if (!rationale.some((r) => r.type !== 'neutral')) {
    rationale.push({
      type: 'neutral',
      text: 'Limited nutrition detail — score relies mainly on ingredients and processing signals',
    });
  }

  return rationale.slice(0, 5);
}

/**
 * One-line summary for variant comparison cards.
 * @param {{ rationale?: Array<{ text: string, type: string }>, grade?: string }} health
 */
export function buildVariantSummaryLine(health) {
  const neg = health.rationale?.find((r) => r.type === 'negative');
  if (neg) {
    return neg.text.replace(/ — main factor lowering the score$/i, '').slice(0, 120);
  }
  const pos = health.rationale?.find((r) => r.type === 'positive');
  if (pos) return pos.text.slice(0, 120);
  return health.grade ? `Grade ${health.grade}` : 'See breakdown for details';
}

/**
 * @param {object} merged
 * @param {{ score: number, flags: object[], ingredients: object[] }} additiveResult
 */
export function buildHealthScore(merged, additiveResult) {
  const macros = scoreMacros(merged.nutrition);
  if (merged.nutritionInferred && macros.items?.length) {
    for (const item of macros.items) {
      item.name = `${item.name} (est.)`;
    }
  }
  const processing = scoreProcessing(merged);
  const nutriscore = scoreNutriscore(merged.nutriscore_grade);
  const additives = { score: additiveResult.score, flags: additiveResult.flags };

  const components = { macros, processing, additives, nutriscore };

  const total = Math.round(
    macros.score * 0.35 +
      processing.score * 0.2 +
      additives.score * 0.25 +
      nutriscore.score * 0.2
  );

  const grade =
    total >= 80 ? 'A' : total >= 65 ? 'B' : total >= 50 ? 'C' : total >= 35 ? 'D' : 'E';

  const rationale = buildHealthRationale(merged, additiveResult, components);

  return {
    total: Math.max(0, Math.min(100, total)),
    grade,
    rationale,
    components,
  };
}
