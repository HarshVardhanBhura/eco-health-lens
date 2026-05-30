import { scoreAdditives, parseIngredientsWithSentiment } from './ingredients.js';
import { buildHealthScore, buildVariantSummaryLine } from './health.js';
import { inferNutritionFromIngredients } from './ingredientInference.js';
import {
  parseVariantBlocks,
  detectVariantsFromTitle,
  collectAllNutritionBlocks,
  assignBlocksToTitleVariants,
} from './variantParse.js';

/**
 * @param {number} total
 */
function gradeFromTotal(total) {
  return total >= 80 ? 'A' : total >= 65 ? 'B' : total >= 50 ? 'C' : total >= 35 ? 'D' : 'E';
}

/**
 * @param {string} a
 * @param {string} b
 */
function namesMatch(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  if (x.includes('cranberry') && y.includes('cranberry')) return true;
  if (x.includes('fruit') && y.includes('fruit')) return true;
  if ((x.includes('70') || x.includes('intense') || x.includes('dark')) && (y.includes('70') || y.includes('intense') || y.includes('dark')))
    return true;
  return false;
}

/**
 * @param {object} baseMerged
 * @param {object} block
 */
function scoreVariantBlock(baseMerged, block) {
  let nutrition = block.nutrition ? { ...block.nutrition, _fromImage: true } : undefined;

  if (!nutrition && block.ingredientsText) {
    const inferred = inferNutritionFromIngredients(block.ingredientsText, baseMerged.packWeightG);
    if (inferred) {
      nutrition = inferred;
      block = { ...block, nutritionInferred: true };
    }
  }

  const merged = {
    ...baseMerged,
    nutrition,
    ingredientsText: block.ingredientsText || baseMerged.ingredientsText || '',
    barcode: block.barcode || baseMerged.barcode,
    nutritionInferred: Boolean(block.nutritionInferred),
  };

  const additiveResult = scoreAdditives(merged.ingredientsText || '');
  const health = buildHealthScore(merged, additiveResult);
  const ingredients =
    additiveResult.ingredients.length > 0
      ? additiveResult.ingredients
      : parseIngredientsWithSentiment(merged.ingredientsText || '');

  return {
    id: block.id,
    name: block.name,
    health,
    summaryLine: buildVariantSummaryLine(health),
    ingredients,
    barcode: block.barcode || undefined,
    nutrition: block.nutrition || undefined,
    dataSource: nutrition?._fromImage
      ? 'label'
      : block.nutritionInferred
        ? 'ingredients_est'
        : 'shared',
  };
}

/**
 * @param {Array<{ name: string, health: { total: number, rationale?: object[] } }>} variants
 */
function buildAverageRationale(variants) {
  /** @type {Array<{ text: string, type: string }>} */
  const rationale = [];
  const sorted = [...variants].sort((a, b) => b.health.total - a.health.total);
  if (sorted.length >= 2) {
    rationale.push({
      type: 'neutral',
      text: `${sorted[0].name} scores highest (${sorted[0].health.total}); ${sorted[sorted.length - 1].name} lowest (${sorted[sorted.length - 1].health.total})`,
    });
  }

  const seen = new Set();
  for (const v of sorted) {
    for (const r of v.health.rationale || []) {
      if (r.type === 'neutral' && /packaging|estimated/i.test(r.text)) continue;
      const key = r.text.slice(0, 40);
      if (seen.has(key) || rationale.length >= 5) continue;
      seen.add(key);
      rationale.push(r);
    }
  }

  if (!rationale.length) {
    rationale.push({
      type: 'neutral',
      text: 'Compare variants below — each flavour is scored separately.',
    });
  }

  return rationale.slice(0, 5);
}

/**
 * Prefer Amazon title variant list; attach OCR nutrition by name or order.
 * @param {object} baseMerged
 * @param {string} [ocrText]
 * @param {string} [title]
 */
/**
 * @param {object} baseMerged
 * @param {string} [ocrText]
 * @param {string} [title]
 * @param {Array<{ id?: string, name?: string, nutrition?: object | null, ingredientsText?: string, barcode?: string | null }>} [prefetchedBlocks]
 */
export function buildMultiVariantAnalysis(baseMerged, ocrText = '', title = '', prefetchedBlocks = null) {
  const collected = collectAllNutritionBlocks(ocrText);
  const ocrBlocks =
    prefetchedBlocks?.length >= 2
      ? prefetchedBlocks
      : collected.length >= 2
        ? collected
        : parseVariantBlocks(ocrText);
  const titleVariants = detectVariantsFromTitle(title);

  /** @type {Array<object>} */
  let blocks = [];

  if (titleVariants.length >= 2) {
    blocks = assignBlocksToTitleVariants(titleVariants, ocrBlocks);
    blocks = blocks.map((block) => {
      if (block.nutrition) return block;
      const ocrMatch = ocrBlocks.find((b) => namesMatch(b.name, block.name));
      if (!ocrMatch) return block;
      return {
        ...block,
        nutrition: ocrMatch.nutrition || null,
        ingredientsText: ocrMatch.ingredientsText || block.ingredientsText || '',
        barcode: ocrMatch.barcode || block.barcode,
      };
    });
  } else if (ocrBlocks.length >= 2) {
    blocks = ocrBlocks;
  }
  if (blocks.length < 2) return null;

  const variants = blocks.map((block) => scoreVariantBlock(baseMerged, block));
  if (variants.length < 2) return null;

  const totals = variants.map((v) => v.health.total);
  const avgTotal = Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);

  const components = averageComponents(variants);

  return {
    variants,
    averageHealth: {
      total: avgTotal,
      grade: gradeFromTotal(avgTotal),
      isAverage: true,
      variantCount: variants.length,
      components,
      rationale: buildAverageRationale(variants),
    },
  };
}

/**
 * @param {Array<{ health: { components: object } }>} variants
 */
function averageComponents(variants) {
  const keys = ['macros', 'additives', 'processing', 'nutriscore'];
  /** @type {Record<string, { score: number }>} */
  const out = {};
  for (const key of keys) {
    const scores = variants
      .map((v) => v.health?.components?.[key]?.score)
      .filter((s) => s != null);
    if (scores.length) {
      out[key] = { score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) };
    }
  }
  if (out.macros) out.macros.items = [];
  if (out.additives) out.additives.flags = [];
  return out;
}
