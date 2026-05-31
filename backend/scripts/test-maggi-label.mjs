import {
  parseNutritionTable,
  parseBestNutritionBlock,
  extractBarcodeFromText,
  extractIngredientsFromOcr,
  hasPackLabelSection,
} from '../scoring/nutritionParse.js';

const maggiMarketingTable = `
Nutritional Information
If a serve is 75 g
Per 100g Per Serve %GDA Per Serve
Energy (kcal) 384 288 14
Protein (g) 8.2 6.2 12
Carbohydrate (g) 59.6 44.7 17
-Total Sugars (g) 1.8 1.4 2
-Added Sugars (g) 1.1 0.8
Total Fat (g) 12.5 9.4 13
Saturated Fat (g) 8.2 6.2 31
Sodium (mg) 1000.0 750.0 31
`;

const n2 = parseNutritionTable(maggiMarketingTable);
if (n2?.energy_kcal !== 384 || n2?.sugar_g !== 1.8) {
  console.error('FAIL marketing table', n2);
  process.exit(1);
}
console.log('OK marketing table', n2.energy_kcal, 'kcal sugar', n2.sugar_g);

const maggiOcr = `
Instant Noodles with Seasoning
Noodles: Refined wheat flour, Palm oil, Iodized salt, Wheat gluten
Masala TASTEMAKER: Mixed spices, Onion powder, Coriander powder
NUTRITIONAL INFORMATION
Per 100 g Per serve (75 g)
Energy (kcal) 457 343
Protein (g) 8.9 6.7
Carbohydrate (g) 62.3 46.7
Total Sugars (g) 2.5 1.9
Added Sugars (g) 0.5 0.4
Total Fat (g) 17.5 13.1
Saturated Fat (g) 8.5 6.4
Trans Fat (g) 0 0
Sodium (mg) 1200 900
8901058012345
NET QUANTITY 900 g
`;

const n = parseNutritionTable(maggiOcr);
if (n?.energy_kcal !== 457) {
  console.error('FAIL energy', n);
  process.exit(1);
}
console.log('OK nutrition per 100g:', n.energy_kcal, 'kcal, sugar', n.sugar_g, 'sodium', n.sodium_mg);

const bc = extractBarcodeFromText(maggiOcr);
if (!bc?.startsWith('890')) {
  console.error('FAIL barcode', bc);
  process.exit(1);
}
console.log('OK barcode', bc);

const ing = extractIngredientsFromOcr(maggiOcr);
if (!/palm oil/i.test(ing) || !/wheat flour/i.test(ing)) {
  console.error('FAIL ingredients', ing.slice(0, 120));
  process.exit(1);
}
console.log('OK ingredients length', ing.length);

if (!hasPackLabelSection(maggiOcr)) {
  console.error('FAIL pack label detection');
  process.exit(1);
}
console.log('OK pack label section detected');
