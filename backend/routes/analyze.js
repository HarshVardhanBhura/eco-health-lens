import { fetchFirstByBarcodes } from '../services/openFoodFacts.js';
import { extractBarcodesFromBuffers, offHasUsableNutrition } from '../services/barcodeScan.js';
import { extractFromProductImages } from '../services/imageOcr.js';
import { mergeProductData } from '../services/merge.js';
import { detectProductType } from '../scoring/detectProductType.js';
import { scoreAdditives, parseIngredientsWithSentiment } from '../scoring/ingredients.js';
import { buildHealthScore } from '../scoring/health.js';
import { buildEcoScore } from '../scoring/eco.js';
import { cacheKey, getCached, setCached } from '../services/cache.js';
import { hasRichIngredientList } from '../scoring/ingredientInference.js';
import { buildMultiVariantAnalysis } from '../scoring/variants.js';
import {
  isConfidentLabelNutrition,
  nutritionFieldCount,
  hasPackLabelSection,
  hasFullNutritionTable,
} from '../scoring/nutritionParse.js';

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
  const likelyFood =
    detectProductType(payload) !== 'non_food' ||
    Boolean(payload.nutrition) ||
    (payload.ingredientsText || '').length > 10 ||
    payload.rawHints?.hasNutrition ||
    payload.rawHints?.hasIngredients;
  const pageNutritionFields = payload.nutrition
    ? Object.keys(payload.nutrition).filter(
        (k) => !['per', 'pack_weight_g'].includes(k) && payload.nutrition[k] != null
      ).length
    : 0;
  const richPageData =
    pageNutritionFields >= 4 && (payload.ingredientsText || '').length > 15;

  const hasBuffers = (payload.productImageBuffers || []).length > 0;
  const skipHeavyOcr = payload.skipImageOcr === true;

  /** @type {string[]} */
  const barcodesToTry = [...new Set([payload.barcode].filter(Boolean))];
  let offHit = barcodesToTry.length ? await fetchFirstByBarcodes(barcodesToTry) : null;

  // Fast barcode scan from pack photos before heavy nutrition-table OCR.
  if (!offHit && likelyFood && hasBuffers && !skipHeavyOcr) {
    const quickScan = await extractBarcodesFromBuffers(payload.productImageBuffers, {
      maxImages: 4,
    });
    for (const b of [quickScan.barcode, ...(quickScan.barcodes || [])].filter(Boolean)) {
      if (!barcodesToTry.includes(b)) barcodesToTry.push(b);
    }
    if (barcodesToTry.length > (payload.barcode ? 1 : 0)) {
      offHit = await fetchFirstByBarcodes(barcodesToTry);
    }
    if (quickScan.barcode && !imageData) {
      imageData = {
        barcode: quickScan.barcode,
        barcodes: quickScan.barcodes,
        sources: quickScan.sources,
        text: '',
        ocrAttempted: true,
        ocrImageCount: 0,
      };
    }
  }

  let offProduct = offHit?.product || null;
  const offSufficient = offHasUsableNutrition(offProduct);

  const runImageOcr =
    !skipHeavyOcr &&
    !richPageData &&
    !offSufficient &&
    (likelyFood ||
      payload.ocrSelectedOnly === true ||
      payload.forceImageOcr === true);

  if (runImageOcr && (payload.productImages?.length || hasBuffers)) {
    const fullOcr = await extractFromProductImages(payload.productImages || [], {
      selectedImageUrl: payload.selectedImageUrl,
      imageBuffers: payload.productImageBuffers,
      ocrSelectedOnly: payload.ocrSelectedOnly === true,
      autoNutritionOcr: payload.autoNutritionOcr === true,
      ocrBudgetMs: offHit ? 18_000 : 28_000,
    });
    imageData = fullOcr || imageData;
    for (const b of [imageData?.barcode, ...(imageData?.barcodes || [])].filter(Boolean)) {
      if (!barcodesToTry.includes(b)) barcodesToTry.push(b);
    }
    if (!offHit && barcodesToTry.length) {
      offHit = await fetchFirstByBarcodes(barcodesToTry);
      offProduct = offHit?.product || offProduct;
    }
  }

  const { merged, sources } = await mergeProductData(payload, offProduct, imageData);
  const productType = detectProductType(merged);
  const confidence = computeConfidence(merged, sources);
  const labelNutritionConfident =
    Boolean(merged.nutrition?._fromImage) ||
    isConfidentLabelNutrition(merged.nutrition, imageData?.text || '');

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
  } else if (
    productType === 'food' &&
    (merged.nutrition?._fromImage ||
      isConfidentLabelNutrition(merged.nutrition, imageData?.text || '')) &&
    !result.variants?.length
  ) {
    result.message =
      'Nutrition read from product packaging images (pack label OCR).';
  } else if (productType === 'food' && merged.packLabelRead && !result.variants?.length) {
    result.message =
      'Pack label read from product images (ingredients from label). Open Food Facts had no barcode match.';
  } else if (productType === 'food' && merged.nutritionInferred && !result.variants?.length) {
    result.message =
      'Macros estimated from ingredient list and pack weight — not from an official nutrition label.';
  } else if (
    productType === 'food' &&
    imageData?.ocrAttempted &&
    !labelNutritionConfident &&
    !merged.nutritionInferred &&
    !result.variants?.length
  ) {
    result.message =
      'Could not read the nutrition table from pack images — try clicking the nutrition label thumbnail in the gallery, then refresh.';
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
    ocrParsedFields: imageData?.ocrParsedFields ?? nutritionFieldCount(merged.nutrition),
    bestNutritionImageId: imageData?.bestNutritionImageId ?? null,
    imageClarity: payload.productImageClarity ?? null,
    labelTableDetected:
      hasFullNutritionTable(imageData?.text || '') ||
      (Boolean(merged.nutrition?._fromImage) &&
        nutritionFieldCount(merged.nutrition) >= 2 &&
        merged.nutrition?.energy_kcal != null),
    autoNutritionOcr: Boolean(payload.autoNutritionOcr),
    nutritionSource: sources.includes('open_food_facts')
      ? 'open_food_facts'
      : labelNutritionConfident
        ? 'label_ocr'
        : merged.packLabelRead
          ? 'pack_label_partial'
          : merged.nutritionInferred
            ? 'ingredient_estimate'
            : merged.nutrition
              ? 'page'
              : 'none',
    packLabelRead: Boolean(merged.packLabelRead),
    parsedNutrition: merged.nutrition
      ? {
          energy_kcal: merged.nutrition.energy_kcal,
          sugar_g: merged.nutrition.sugar_g,
          carbs_g: merged.nutrition.carbs_g,
          fieldCount: nutritionFieldCount(merged.nutrition),
          fromImage: Boolean(merged.nutrition._fromImage),
          confident: labelNutritionConfident,
        }
      : null,
  };

  const cacheable =
    labelNutritionConfident ||
    merged.packLabelRead ||
    sources.includes('open_food_facts') ||
    (!merged.nutritionInferred && confidence !== 'low');
  if (cacheable) setCached(key, result);

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
