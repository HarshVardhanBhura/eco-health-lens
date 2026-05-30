import { inferNutritionFromIngredients } from '../scoring/ingredientInference.js';
import { parseBestNutritionBlock } from '../scoring/nutritionParse.js';
import { extractFromProductImages } from './imageOcr.js';

/**
 * Merge page payload with Open Food Facts enrichment.
 * @param {object} page
 * @param {object | null} offProduct raw OFF product
 * @param {Awaited<ReturnType<typeof extractFromProductImages>> | null} [imageData]
 */
export async function mergeProductData(page, offProduct, imageData = null) {
  /** @type {string[]} */
  const sources = ['page'];
  /** @type {object} */
  const merged = {
    retailer: page.retailer,
    asin: page.asin,
    url: page.url,
    title: page.title,
    category: page.category,
    barcode: page.barcode,
    ingredientsText: page.ingredientsText || '',
    materialsText: page.materialsText || '',
    packWeightG: page.packWeightG,
    nutrition: page.nutrition ? { ...page.nutrition } : undefined,
    rawHints: { ...(page.rawHints || {}) },
  };

  if (imageData) {
    applyImageExtraction(merged, sources, imageData);
  }

  if (!offProduct) {
    applyIngredientInference(merged, sources);
    return { merged, sources };
  }

  sources.push('open_food_facts');

  const offIngredients = offProduct.ingredients_text || offProduct.ingredients_text_en;
  if (offIngredients && (!merged.ingredientsText || merged.ingredientsText.length < offIngredients.length)) {
    merged.ingredientsText = offIngredients;
  }

  const n = offProduct.nutriments || {};
  const offNutrition = {
    per: '100g',
    protein_g: n.proteins_100g ?? n.proteins,
    carbs_g: n.carbohydrates_100g ?? n.carbohydrates,
    fat_g: n.fat_100g ?? n.fat,
    saturated_fat_g: n['saturated-fat_100g'] ?? n['saturated-fat'],
    fiber_g: n.fiber_100g ?? n.fiber,
    sugar_g: n.sugars_100g ?? n.sugars,
    salt_g: n.salt_100g ?? n.salt,
    energy_kcal: n['energy-kcal_100g'] ?? n['energy-kcal'],
  };

  const hasOffNutrients = Object.values(offNutrition).some((v) => v != null && v !== '100g');
  if (hasOffNutrients) {
    merged.nutrition = { ...(merged.nutrition || {}), ...pickDefined(offNutrition) };
  }

  if (offProduct.nutriscore_grade) merged.nutriscore_grade = offProduct.nutriscore_grade;
  if (offProduct.ecoscore_grade) merged.ecoscore_grade = offProduct.ecoscore_grade;
  if (offProduct.nova_group != null) merged.nova_group = offProduct.nova_group;
  if (offProduct.product_name && !merged.title) merged.title = offProduct.product_name;

  if (hasOffNutrients) {
    merged.nutritionInferred = false;
  } else {
    applyIngredientInference(merged, sources);
  }

  return { merged, sources };
}

function hasTableNutrition(nutrition) {
  return (
    nutrition &&
    Object.keys(nutrition).filter((k) => !k.startsWith('_') && k !== 'per' && k !== 'pack_weight_g').length > 0 &&
    !nutrition._inferred
  );
}

function hasLabelNutrition(nutrition) {
  return hasTableNutrition(nutrition) || Boolean(nutrition?._fromImage);
}

function applyImageExtraction(merged, sources, imageData) {
  for (const s of imageData.sources || ['product_image_ocr']) {
    if (!sources.includes(s)) sources.push(s);
  }

  if (imageData.barcode && !merged.barcode) merged.barcode = imageData.barcode;

  if (imageData.ingredientsText?.length > (merged.ingredientsText?.length || 0)) {
    merged.ingredientsText = imageData.ingredientsText;
  }

  const imgNutrition = imageData.nutrition || parseBestNutritionBlock(imageData.text || '');
  if (imgNutrition && !hasLabelNutrition(merged.nutrition)) {
    merged.nutrition = { ...imgNutrition, _fromImage: true };
    merged.nutritionInferred = false;
  }
}

function applyIngredientInference(merged, sources) {
  if (hasLabelNutrition(merged.nutrition)) return;
  if (!merged.ingredientsText) return;
  const inferred = inferNutritionFromIngredients(merged.ingredientsText, merged.packWeightG);
  if (!inferred) return;
  merged.nutrition = inferred;
  merged.nutritionInferred = true;
  if (!sources.includes('ingredient_inference')) {
    sources.push('ingredient_inference');
  }
}

/** @param {Record<string, unknown>} obj */
function pickDefined(obj) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && v !== '') out[k] = v;
  }
  return out;
}
