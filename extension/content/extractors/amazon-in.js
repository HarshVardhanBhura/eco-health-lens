/**
 * Amazon India DOM extractor — builds normalized ProductPayload.
 */

const ASIN_REGEX = /(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})/i;

/** @param {string[]} selectors */
function queryFirst(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** @param {string} text */
function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {import('../../shared/types.js').ProductPayload} registry unused — selectors loaded inline
 */
function extractAsin() {
  const match = window.location.pathname.match(ASIN_REGEX);
  if (match) return match[1].toUpperCase();
  const meta = document.querySelector('input[name="ASIN"], #ASIN');
  if (meta && 'value' in meta) return String(meta.value).toUpperCase();
  return '';
}

/** @param {Record<string, string[]>} selectors */
function extractTitle(selectors) {
  const el = queryFirst(selectors.title || ['#productTitle']);
  return el ? normalizeText(el.textContent) : '';
}

/** @param {Record<string, string[]>} selectors */
function extractCategory(selectors) {
  const el = queryFirst(selectors.breadcrumbs || ['#wayfinding-breadcrumbs_feature_div']);
  if (!el) return '';
  return normalizeText(el.textContent);
}

/**
 * @param {string} haystack
 * @param {string[]} labels
 */
function findLabeledValue(haystack, labels) {
  const lower = haystack.toLowerCase();
  for (const label of labels) {
    const idx = lower.indexOf(label.toLowerCase());
    if (idx === -1) continue;
    const slice = haystack.slice(idx + label.length);
    const cleaned = slice.replace(/^[\s:：\-–]+/, '').split('\n')[0].trim();
    if (cleaned.length > 2 && cleaned.length < 200) return cleaned;
  }
  return '';
}

/** @param {Record<string, string[]>} selectors */
function extractBarcode(selectors) {
  const containers = [
    ...(selectors.detailBullets || []),
    ...(selectors.techSpec || []),
    ...(selectors.productDetails || []),
  ];
  let blob = '';
  for (const sel of containers) {
    document.querySelectorAll(sel).forEach((el) => {
      blob += '\n' + (el.textContent || '');
    });
  }
  const labels = selectors.barcodeLabels || ['ean', 'upc', 'barcode', 'gtin'];
  for (const label of labels) {
    const re = new RegExp(`${label}[^\\d]*(\\d{8,14})`, 'i');
    const m = blob.match(re);
    if (m) return m[1];
  }
  const any = blob.match(/\b(\d{13}|\d{12}|\d{8})\b/);
  return any ? any[1] : '';
}

/** @param {string} text */
function extractIngredientsFromText(text) {
  const lower = text.toLowerCase();
  const markers = ['ingredients:', 'ingredients', 'contains:'];
  for (const m of markers) {
    const idx = lower.indexOf(m);
    if (idx === -1) continue;
    let rest = text.slice(idx + m.length).trim();
    const stop = rest.search(/\n\s*(allergen|nutrition|storage|directions|manufactured)/i);
    if (stop > 0) rest = rest.slice(0, stop);
    return normalizeText(rest);
  }
  return '';
}

/** @param {Record<string, string[]>} selectors */
function extractIngredients(selectors) {
  const parts = [];
  const info = queryFirst(selectors.importantInfo || ['#important-information']);
  if (info) parts.push(info.textContent || '');

  document.querySelectorAll('#feature-bullets li, #productFactsDesktopExpander').forEach((el) => {
    const t = (el.textContent || '').toLowerCase();
    if (t.includes('ingredient')) parts.push(el.textContent || '');
  });

  for (const sel of selectors.productDetails || []) {
    document.querySelectorAll(sel).forEach((el) => {
      parts.push(el.textContent || '');
    });
  }

  const blob = parts.join('\n');
  return extractIngredientsFromText(blob) || findLabeledValue(blob, selectors.ingredientKeywords || ['ingredients']);
}

/**
 * @param {string} text
 * @returns {Record<string, number | string>}
 */
function parseNutritionTable(text) {
  /** @type {Record<string, number | string>} */
  const nutrition = { per: '100g' };
  const patterns = [
    [/protein[:\s]+([\d.]+)\s*g/i, 'protein_g'],
    [/carbohydrate[s]?[:\s]+([\d.]+)\s*g/i, 'carbs_g'],
    [/carb[s]?[:\s]+([\d.]+)\s*g/i, 'carbs_g'],
    [/fat[:\s]+([\d.]+)\s*g/i, 'fat_g'],
    [/saturat(?:ed|es)?\s*fat[:\s]+([\d.]+)\s*g/i, 'saturated_fat_g'],
    [/fibre|fiber[:\s]+([\d.]+)\s*g/i, 'fiber_g'],
    [/sugar[s]?[:\s]+([\d.]+)\s*g/i, 'sugar_g'],
    [/salt[:\s]+([\d.]+)\s*g/i, 'salt_g'],
    [/sodium[:\s]+([\d.]+)\s*g/i, 'sodium_g'],
    [/energy[:\s]+([\d.]+)\s*kcal/i, 'energy_kcal'],
  ];
  for (const [re, key] of patterns) {
    const m = text.match(re);
    if (m) nutrition[key] = parseFloat(m[1]);
  }
  if (text.match(/per\s+serving/i)) nutrition.per = 'serving';
  return nutrition;
}

/** @param {Record<string, string[]>} selectors */
function extractNutrition(selectors) {
  let blob = '';
  const keywords = selectors.nutritionKeywords || ['nutrition'];
  document.querySelectorAll('table').forEach((table) => {
    const t = (table.textContent || '').toLowerCase();
    if (keywords.some((k) => t.includes(k.toLowerCase()))) {
      blob += '\n' + table.textContent;
    }
  });
  document.querySelectorAll('#important-information, #productDetails_feature_div').forEach((el) => {
    const t = (el.textContent || '').toLowerCase();
    if (keywords.some((k) => t.includes(k.toLowerCase()))) {
      blob += '\n' + el.textContent;
    }
  });
  const parsed = parseNutritionTable(blob);
  return Object.keys(parsed).length > 1 ? parsed : null;
}

/** @param {string} title
 * @param {string} category
 * @param {string} ingredientsText
 * @param {Record<string, number | string> | null} nutrition
 */
function extractRawHints(title, category, ingredientsText, nutrition) {
  const blob = `${title} ${category} ${ingredientsText}`.toLowerCase();
  return {
    organic: /\borganic\b/.test(blob),
    recyclable: /\brecycl(e|able)|fsc\b/.test(blob),
    plasticPackaging: /\bplastic\b|single.?use|non.?recyclable/.test(blob),
    wholeGrain: /\bwhole\s*(grain|wheat)\b/.test(blob),
    noAddedSugar: /\bno\s+added\s+sugar\b/.test(blob),
    hasNutrition: Boolean(nutrition && Object.keys(nutrition).length > 1),
    hasIngredients: ingredientsText.length > 10,
  };
}

/**
 * @param {Record<string, string[]>} selectorRegistry
 * @returns {import('../../shared/types.js').ProductPayload | null}
 */
function buildPayload(selectorRegistry) {
  const asin = extractAsin();
  if (!asin) return null;

  const title = extractTitle(selectorRegistry);
  const category = extractCategory(selectorRegistry);
  const ingredientsText = extractIngredients(selectorRegistry);
  const nutrition = extractNutrition(selectorRegistry);
  const barcode = extractBarcode(selectorRegistry);
  const rawHints = extractRawHints(title, category, ingredientsText, nutrition);

  return {
    retailer: 'amazon_in',
    asin,
    url: window.location.href,
    title,
    category,
    barcode: barcode || undefined,
    ingredientsText: ingredientsText || undefined,
    nutrition: nutrition || undefined,
    rawHints,
  };
}
