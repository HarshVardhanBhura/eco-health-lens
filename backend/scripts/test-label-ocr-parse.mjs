import { parseNutritionTable } from '../scoring/nutritionParse.js';
import { sanitizeIngredientsText, splitIngredients } from '../scoring/ingredients.js';
import { scoreAdditives } from '../scoring/ingredients.js';

const labelOcr = `
NUTRITION INFORMATION
Energy 575 kcal
Protein 6.2 g
Carbohydrate 53.8 g
Total Sugars 28 g
Added Sugars 27.6 g
Total Fat 37.2 g
Saturated fatty acids 24.7 g
`;

const n = parseNutritionTable(labelOcr);
if (n?.energy_kcal !== 575) {
  console.error('FAIL energy', n?.energy_kcal);
  process.exit(1);
}
console.log('OK nutrition parse', n.energy_kcal, 'kcal, sugar', n.sugar_g);

const messy =
  'Sugar, butter, palm oil. legal disclaimer: actual product packaging may contain more. Warnings And directions before using.';
const clean = sanitizeIngredientsText(messy);
const parts = splitIngredients(clean);
if (parts.some((p) => /directions|disclaimer|warnings/i.test(p))) {
  console.error('FAIL ingredient sanitize', parts);
  process.exit(1);
}
console.log('OK ingredients', parts);

const palm = scoreAdditives('Refined wheat flour, Palm oil, Sugar, Palm olein');
if (palm.flags.length !== 1) {
  console.error('FAIL palm dedupe', palm.flags);
  process.exit(1);
}
console.log('OK palm flag once:', palm.flags[0].reason);
