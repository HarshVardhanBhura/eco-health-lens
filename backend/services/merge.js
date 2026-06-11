import {
  inferNutritionFromIngredients,
  hasRichIngredientList,
} from '../scoring/ingredientInference.js';
import {
  parseBestNutritionBlock,
  nutritionFieldCount,
  hasPackLabelSection,
  isConfidentLabelNutrition,
  sanitizeNutritionPer100g,
} from '../scoring/nutritionParse.js';
import { sanitizeIngredientsText } from '../scoring/ingredients.js';
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
    ingredientsText: sanitizeIngredientsText(page.ingredientsText || ''),
    materialsText: page.materialsText || '',
    packWeightG: page.packWeightG,
    nutrition: page.nutrition ? { ...page.nutrition } : undefined,
    rawHints: { ...(page.rawHints || {}) },
  };

  if (imageData) {
    applyImageExtraction(merged, sources, imageData);
  }

  applyPageNutritionText(merged, page);

  if (!offProduct) {
    applyIngredientInference(merged, sources, imageData, page);
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

  // OFF product found — never fall back to ingredient macro guessing (that
  // contradicts "Nutrition from Open Food Facts" even when OFF nutriments are sparse).
  merged.offEnriched = true;
  merged.nutritionInferred = false;

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

function applyPageNutritionText(merged, page) {
  const blob = page.nutritionPageText || '';
  if (!blob.trim()) return;

  const parsed = sanitizeNutritionPer100g(parseBestNutritionBlock(blob));
  if (!parsed || !isConfidentLabelNutrition(parsed, blob)) return;

  const fields = nutritionFieldCount(parsed);
  const mergedFields = nutritionFieldCount(merged.nutrition);
  if (fields >= mergedFields) {
    merged.nutrition = { ...parsed, _fromImage: true, _fromPage: true };
    merged.nutritionInferred = false;
    merged.packLabelRead = true;
  }
}

function applyImageExtraction(merged, sources, imageData) {
  for (const s of imageData.sources || ['product_image_ocr']) {
    if (!sources.includes(s)) sources.push(s);
  }

  if (imageData.barcode && !merged.barcode) merged.barcode = imageData.barcode;
  if (!merged.barcode && imageData.barcodes?.length) {
    merged.barcode = imageData.barcodes.find((b) => b.length === 13) || imageData.barcodes[0];
  }

  const ocrIngredients = sanitizeIngredientsText(imageData.ingredientsText || '');
  if (ocrIngredients.length > 20) {
    const pageLen = merged.ingredientsText?.length || 0;
    const pageHasBoilerplate = /legal disclaimer|warnings?\b|directions before/i.test(
      merged.ingredientsText || ''
    );
    if (
      ocrIngredients.length > pageLen ||
      pageHasBoilerplate ||
      !merged.ingredientsText
    ) {
      merged.ingredientsText = ocrIngredients;
    }
  }

  const imgNutrition = sanitizeNutritionPer100g(
    imageData.nutrition || parseBestNutritionBlock(imageData.text || '')
  );
  const imgFields = nutritionFieldCount(imgNutrition);
  const mergedFields = nutritionFieldCount(merged.nutrition);

  const labelText = imageData.text || '';

  if (
    (imgNutrition && isConfidentLabelNutrition(imgNutrition, labelText)) ||
    (imageData.nutritionConfident && imgNutrition)
  ) {
    merged.nutrition = { ...imgNutrition, _fromImage: true };
    merged.nutritionInferred = false;
    merged.packLabelRead = true;
  } else if (
    imgNutrition &&
    imgFields >= 2 &&
    (merged.nutritionInferred ||
      !hasLabelNutrition(merged.nutrition) ||
      imgFields > mergedFields ||
      (imgFields >= 3 && imgNutrition.energy_kcal != null))
  ) {
    merged.nutrition = { ...imgNutrition, _fromImage: true };
    merged.nutritionInferred = false;
    if (imgFields >= 3) merged.packLabelRead = true;
  }

  if (
    imageData.labelPackDetected ||
    (imageData.ocrImageCount > 0 && hasPackLabelSection(labelText))
  ) {
    merged.packLabelRead = true;
  }
}

/**
 * @param {object} merged
 * @param {Awaited<ReturnType<typeof extractFromProductImages>> | null} imageData
 */
function shouldSkipIngredientInference(merged, imageData) {
  if (hasLabelNutrition(merged.nutrition)) return true;
  if (merged.packLabelRead) return true;
  if (!imageData) return false;

  const text = imageData.text || '';
  const parsed =
    imageData.nutrition || parseBestNutritionBlock(text);

  if (imageData.ocrImageCount > 0 && imageData.sources?.includes('product_image_ocr')) {
    if (hasPackLabelSection(text)) return true;
    if (parsed?.energy_kcal >= 200 && parsed?.energy_kcal <= 700) return true;
    if ((imageData.ingredientsText || '').length > 15) return true;
    if (/noodles\s*:|tastemaker|refined wheat flour/i.test(text)) return true;
  }

  if (!hasPackLabelSection(text)) return false;

  const ocrIng = (imageData.ingredientsText || '').length > 25;
  const ocrNut = nutritionFieldCount(parsed) >= 2;

  return ocrIng || ocrNut;
}

function applyIngredientInference(merged, sources, imageData = null, page = null) {
  if (shouldSkipIngredientInference(merged, imageData)) return;
  // Pack photos were uploaded — never substitute macro guesses if label OCR did not succeed.
  if (
    (page?.productImageBuffers?.length || page?.productImages?.length) &&
    !hasLabelNutrition(merged.nutrition)
  ) {
    return;
  }
  // Pack OCR was attempted but no official label table — do not substitute guesses.
  if (imageData?.ocrAttempted && !hasLabelNutrition(merged.nutrition)) {
    return;
  }
  if (imageData?.sources?.includes('product_image_ocr') && !hasLabelNutrition(merged.nutrition)) {
    return;
  }
  if (!merged.ingredientsText) return;
  if (!hasRichIngredientList(merged.ingredientsText)) return;
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
