import {
  parseNutritionTable,
  parseBestNutritionBlock,
  extractBarcodeFromText,
  extractIngredientsFromOcr,
  hasPackLabelSection,
  isConfidentLabelNutrition,
  sanitizeNutritionPer100g,
  refineEnergyFromLabel,
  estimateKcalFromMacros,
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

const flatOcr = `Maggi 2-Minute Masala NUTRITIONAL INFORMATION Per 100g Energy (kcal) 384 Protein (g) 8.2 Carbohydrate (g) 59.6 Total Sugars (g) 1.8 Total Fat (g) 12.5 Saturated Fat (g) 8.2 Sodium (mg) 1000`;
const flatParsed = parseBestNutritionBlock(flatOcr);
if (!isConfidentLabelNutrition(flatParsed, flatOcr) || flatParsed?.energy_kcal !== 384) {
  console.error('FAIL flat OCR', flatParsed);
  process.exit(1);
}
console.log('OK flat OCR confident', flatParsed.energy_kcal, 'kcal');

const seqOcr =
  'Nutritional Information Per 100g Per Serve Energy (kcal) 384 288 14 Protein (g) 8.2 6.2 12 Carbohydrate (g) 59.6 44.7 17 Total Sugars (g) 1.8 1.4 2 Added Sugars (g) 1.1 0.8 Total Fat (g) 12.5 9.4 13 Saturated Fat (g) 8.2 6.2 31 Sodium (mg) 1000.0 750.0 31';
const seqParsed = parseBestNutritionBlock(seqOcr);
if (!isConfidentLabelNutrition(seqParsed, seqOcr) || seqParsed?.energy_kcal !== 384) {
  console.error('FAIL FSSAI number sequence', seqParsed);
  process.exit(1);
}
console.log('OK FSSAI sequence', seqParsed.energy_kcal, 'kcal sugar', seqParsed.sugar_g);

const garbage = sanitizeNutritionPer100g({
  energy_kcal: 508,
  protein_g: 500,
  carbs_g: 508,
  sugar_g: 0,
});
if (garbage?.protein_g != null || garbage?.carbs_g != null) {
  console.error('FAIL should strip impossible macros', garbage);
  process.exit(1);
}
console.log('OK rejects 500g protein / 508g carbs misparses');

const label384 = `Nutritional Information Per 100g Per Serve
Energy (kcal) 384 288 14
Protein (g) 8.2 6.2 12
Carbohydrate (g) 59.6 44.7 17
Total Sugars (g) 1.8 1.4 2`;
const bad508 = refineEnergyFromLabel(
  label384,
  sanitizeNutritionPer100g({ energy_kcal: 508, sugar_g: 2, protein_g: 8.2 })
);
if (bad508?.energy_kcal !== 384) {
  console.error('FAIL energy refine (expect 384 kcal per 100g)', bad508);
  process.exit(1);
}
console.log('OK energy row picks 384 not 508');

const maggiMacros = { protein_g: 8.2, carbs_g: 59.6, fat_g: 12.5, sugar_g: 2.2, energy_kcal: 412 };
const est = estimateKcalFromMacros(maggiMacros);
if (est < 370 || est > 400) {
  console.error('FAIL macro estimate', est);
  process.exit(1);
}
const pick384 = refineEnergyFromLabel(
  'Nutritional Information Per 100g Energy (kcal) 384 269 14 Protein (g) 8.2',
  maggiMacros
);
if (pick384?.energy_kcal !== 384) {
  console.error('FAIL per-100g energy column', pick384);
  process.exit(1);
}
const noTable = refineEnergyFromLabel('Maggi MEGA PACK masala taste', { energy_kcal: 451, sugar_g: 3 });
if (noTable?.energy_kcal != null) {
  console.error('FAIL should drop energy without nutrition table', noTable);
  process.exit(1);
}
console.log('OK energy only from nutrition table OCR');

const gdaFront =
  'MEGA PACK Nutrition Information Energy 451 kcal Total Sugars 1.0g 384 kcal per 100g';
const gdaFixed = refineEnergyFromLabel(gdaFront, {
  energy_kcal: 451,
  sugar_g: 1,
  fat_g: 13.5,
});
if (gdaFixed?.energy_kcal !== 384) {
  console.error('FAIL GDA should prefer explicit 384 kcal', gdaFixed);
  process.exit(1);
}
console.log('OK GDA front pack picks 384 kcal not 451');

const garbledMaggiOcr = `Nutrition Information
Energy 384
Frwy hay 384 288 ts
Carhatyduate ig 59.6 ey (EX
Tate Sagas nt 1 et Pa
Acded Sugsan iq) 1 ne
BATanted FAL 1005 mers than) 82 2 J1-`;
const garbledParsed = parseBestNutritionBlock(garbledMaggiOcr);
if (
  garbledParsed?.energy_kcal !== 384 ||
  garbledParsed?.carbs_g !== 59.6 ||
  garbledParsed?.sugar_g !== 1.8 ||
  garbledParsed?.fat_g < 11 ||
  garbledParsed?.fat_g > 14
) {
  console.error('FAIL garbled OCR macros', garbledParsed);
  process.exit(1);
}
console.log(
  'OK garbled OCR',
  garbledParsed.carbs_g,
  'g carbs',
  garbledParsed.sugar_g,
  'g sugar',
  garbledParsed.fat_g,
  'g fat'
);
