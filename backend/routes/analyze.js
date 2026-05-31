import { fetchFirstByBarcodes } from '../services/openFoodFacts.js';
import { extractFromProductImages } from '../services/imageOcr.js';
import { mergeProductData } from '../services/merge.js';
import { detectProductType } from '../scoring/detectProductType.js';
import { scoreAdditives, parseIngredientsWithSentiment } from '../scoring/ingredients.js';
import { buildHealthScore } from '../scoring/health.js';
import { buildEcoScore } from '../scoring/eco.js';
import { cacheKey, getCached, setCached } from '../services/cache.js';
import { hasRichIngredientList } from '../scoring/ingredientInference.js';
import { buildMultiVariantAnalysis } from '../scoring/variants.js';

const DISCLAIMER =
  'Informational only — not medical advice, not environmental certification, not affiliated with Amazon.';

/**
 * @param {object} payload
 */
function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') return 'Invalid body';
  if (!payload.retailer) return 'retailer is required';
  if (!payload.asin && !payload.barcode) return 'asin or barcode is required';
  if (!payload.title && !payload.url) return 'title or url is required';
  return null;
}

/**
 * @param {object} merged
 * @param {string[]} sources
 */
function computeConfidence(merged, sources) {
  const hasOff = sources.includes('open_food_facts');
  const hasImageNutrition = Boolean(merged.nutrition?._fromImage);
  const hasTableNutrition =
    merged.nutrition &&
    Object.keys(merged.nutrition).filter(
      (k) => !k.startsWith('_') && k !== 'per' && k !== 'pack_weight_g'
    ).length > 0 &&
    !merged.nutritionInferred;
  const hasInferredNutrition = Boolean(merged.nutritionInferred);
  const hasIngredients = (merged.ingredientsText || '').length > 10;
  const richIngredients = hasRichIngredientList(merged.ingredientsText || '');

  if (hasOff && (hasTableNutrition || hasImageNutrition || hasInferredNutrition) && hasIngredients)
    return 'high';
  if ((hasTableNutrition || hasImageNutrition) && hasIngredients) return 'high';
  if (hasImageNutrition && richIngredients) return 'high';
  if (hasInferredNutrition && richIngredients) return 'medium';
  if (richIngredients && hasIngredients) return 'medium';
  if ((hasTableNutrition || hasInferredNutrition) && (hasOff || hasTableNutrition)) return 'medium';
  if (hasIngredients && (hasOff || hasTableNutrition)) return 'medium';
  return 'low';
}

/**
 * @param {object} payload
 */
export async function analyzeProduct(payload) {
  const key = cacheKey(payload);
  const hit = getCached(key);
  if (hit) return hit;

  let imageData = null;
  if (payload.productImages?.length || payload.productImageBuffers?.length) {
    imageData = await extractFromProductImages(payload.productImages || [], {
      selectedImageUrl: payload.selectedImageUrl,
      imageBuffers: payload.productImageBuffers,
    });
  }

  const barcodesToTry = [
    payload.barcode,
    imageData?.barcode,
    ...(imageData?.barcodes || []),
  ].filter(Boolean);

  const offHit = barcodesToTry.length ? await fetchFirstByBarcodes(barcodesToTry) : null;
  const offProduct = offHit?.product || null;

  const { merged, sources } = await mergeProductData(payload, offProduct, imageData);
  const productType = detectProductType(merged);
  const confidence = computeConfidence(merged, sources);

  const additiveResult = scoreAdditives(merged.ingredientsText || '');
  let ingredients =
    additiveResult.ingredients.length > 0
      ? additiveResult.ingredients
      : parseIngredientsWithSentiment(merged.ingredientsText || '');

  /** @type {object} */
  const result = {
    productType,
    confidence,
    health: null,
    eco: null,
    ingredients,
    sources,
    disclaimer: DISCLAIMER,
    title: merged.title,
    asin: merged.asin,
  };

  const showHealth = productType === 'food' || productType === 'ambiguous';
  const showEco = productType === 'non_food' || productType === 'ambiguous';

  const multiVariant = showHealth
    ? buildMultiVariantAnalysis(
        merged,
        imageData?.text || '',
        merged.title || payload.title || '',
        imageData?.variants
      )
    : null;

  if (multiVariant) {
    result.variants = multiVariant.variants;
    result.health = multiVariant.averageHealth;
    result.ingredients = multiVariant.variants[0]?.ingredients || ingredients;
    if (!sources.includes('combo_variants')) sources.push('combo_variants');
    result.message =
      'Multi-flavour pack — scores reflect all flavours in this listing. Expand below to compare.';
    result.confidence = 'medium';
  } else if (showHealth) {
    result.health = buildHealthScore(merged, additiveResult);
  }
  if (showEco) {
    result.eco = buildEcoScore(merged);
  }
  if (productType === 'non_food' && !result.eco) {
    result.eco = buildEcoScore(merged);
  }

  if (productType === 'non_food' && result.eco?.insufficientData) {
    result.message =
      'No reliable eco rating — material or fabric composition was not found on this listing (e.g. Material / Fabric field).';
  } else if (productType === 'food' && sources.includes('open_food_facts') && !result.variants?.length) {
    result.message = offHit?.barcode
      ? `Nutrition from Open Food Facts (barcode ${offHit.barcode}).`
      : 'Nutrition from Open Food Facts.';
  } else if (productType === 'food' && merged.nutrition?._fromImage && !result.variants?.length) {
    result.message =
      'Nutrition read from product packaging images (pack label OCR).';
  } else if (productType === 'food' && merged.packLabelRead && !result.variants?.length) {
    result.message =
      'Pack label read from product images (ingredients from label). Open Food Facts had no barcode match.';
  } else if (productType === 'food' && merged.nutritionInferred && !result.variants?.length) {
    result.message =
      'Macros estimated from ingredient list and pack weight — not from an official nutrition label.';
  } else if (productType === 'food' && confidence === 'low') {
    result.message =
      'Limited product data — a full ingredient list or nutrition table on the listing improves accuracy.';
  } else if (confidence === 'low') {
    result.message = 'Limited product data — scores may be incomplete.';
  }
  if (
    showHealth &&
    !result.health?.components?.macros?.items?.length &&
    !sources.includes('open_food_facts') &&
    !merged.nutritionInferred
  ) {
    result.message =
      result.message ||
      'No nutrition table found — health score uses ingredients and heuristics only.';
  }

  result.enrichment = {
    barcode: merged.barcode || offHit?.barcode || null,
    barcodesTried: [...new Set(barcodesToTry)],
    offMatched: Boolean(offProduct),
    ocrRan: Boolean(imageData?.sources?.includes('product_image_ocr')),
    ocrImageCount: imageData?.ocrImageCount ?? 0,
    nutritionSource: sources.includes('open_food_facts')
      ? 'open_food_facts'
      : merged.nutrition?._fromImage
        ? 'label_ocr'
        : merged.packLabelRead
          ? 'pack_label_partial'
          : merged.nutritionInferred
            ? 'ingredient_estimate'
            : merged.nutrition
              ? 'page'
              : 'none',
    packLabelRead: Boolean(merged.packLabelRead),
  };

  setCached(key, result);
  return result;
}

/** Fastify route registration (optional entry: server-fastify.js) */
export async function registerAnalyzeRoutes(fastify) {
  fastify.post('/v1/analyze', async (request, reply) => {
    const err = validatePayload(request.body);
    if (err) return reply.code(400).send({ error: err });
    try {
      return await analyzeProduct(request.body);
    } catch (e) {
      request.log.error(e);
      return reply.code(500).send({ error: 'Analysis failed' });
    }
  });
}
