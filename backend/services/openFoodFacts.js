const OFF_BASE = 'https://world.openfoodfacts.org/api/v2/product';

/**
 * @param {string} barcode
 * @returns {Promise<object | null>}
 */
/**
 * Try barcodes in order (EAN-13 first) until OFF returns a product.
 * @param {string[]} barcodes
 */
export async function fetchFirstByBarcodes(barcodes) {
  const unique = [...new Set((barcodes || []).filter((b) => /^\d{8,14}$/.test(b)))]
    .sort((a, b) => {
      if (a.length === 13 && b.length !== 13) return -1;
      if (b.length === 13 && a.length !== 13) return 1;
      return b.length - a.length;
    });
  for (const barcode of unique) {
    const product = await fetchByBarcode(barcode);
    if (product) return { product, barcode };
  }
  return null;
}

export async function fetchByBarcode(barcode) {
  if (!barcode || !/^\d{8,14}$/.test(barcode)) return null;

  const url = `${OFF_BASE}/${barcode}.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'EcoHealthLens/1.0 (educational MVP)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 1 || !data.product) return null;
    return data.product;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {object} product OFF product object
 */
export function mapOffToEnrichment(product) {
  const n = product.nutriments || {};
  return {
    nutriscore_grade: product.nutriscore_grade || product.nutrition_grades,
    ecoscore_grade: product.ecoscore_grade,
    nova_group: product.nova_group,
    ingredientsText: product.ingredients_text || product.ingredients_text_en,
    nutrition: {
      per: '100g',
      protein_g: n.proteins_100g ?? n.proteins,
      carbs_g: n.carbohydrates_100g ?? n.carbohydrates,
      fat_g: n.fat_100g ?? n.fat,
      saturated_fat_g: n['saturated-fat_100g'] ?? n['saturated-fat'],
      fiber_g: n.fiber_100g ?? n.fiber,
      sugar_g: n.sugars_100g ?? n.sugars,
      salt_g: n.salt_100g ?? n.salt,
      energy_kcal: n['energy-kcal_100g'] ?? n['energy-kcal'],
    },
    offProductName: product.product_name,
  };
}
