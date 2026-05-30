import { parseNutritionTable } from '../scoring/nutritionParse.js';
import {
  detectVariantsFromTitle,
  collectAllNutritionBlocks,
  assignBlocksToTitleVariants,
} from '../scoring/variantParse.js';
import { buildMultiVariantAnalysis } from '../scoring/variants.js';

const title =
  'Cadbury Bournville Dark Chocolate Bars Combo (2 x Cranberry 78 gm, 2 x Fruit & Nut 75 gm, 2 x 70% Dark Chocolate Bar 75 gm)';

const ocrSample = `
CRANBERRY
Nutrition Information
Energy 526 kcal
Protein 5.3 g
Carbohydrate 58.2 g
Total Sugars 45.7 g
Total Fat 30.1 g
8901234567890

FRUIT & NUT
Nutrition Information
Energy 533 kcal
Protein 6.1 g
Carbohydrate 57.0 g
Total Sugars 44.2 g
Total Fat 31.5 g
8901234567891

INTENSE 70
Nutrition Information
Energy 588 kcal
Protein 9.8 g
Carbohydrate 22.1 g
Total Sugars 24.4 g
Total Fat 47.4 g
8901234567892
`;

const titleVariants = detectVariantsFromTitle(title);
const blocks = collectAllNutritionBlocks(ocrSample);
const assigned = assignBlocksToTitleVariants(titleVariants, blocks);
const analysis = buildMultiVariantAnalysis(
  { ingredientsText: 'cocoa, sugar', packWeightG: 75 },
  ocrSample,
  title,
  blocks
);

console.log('Title variants:', titleVariants.length);
console.log('OCR blocks:', blocks.length, blocks.map((b) => b.nutrition?.energy_kcal));
console.log(
  'Assigned:',
  assigned.map((a) => ({ name: a.name, kcal: a.nutrition?.energy_kcal, sugar: a.nutrition?.sugar_g }))
);
console.log(
  'Health scores:',
  analysis?.variants?.map((v) => ({
    name: v.name,
    total: v.health.total,
    summary: v.summaryLine,
    source: v.dataSource,
  }))
);
console.log('Avg rationale:', analysis?.averageHealth?.rationale?.map((r) => r.text));

const totals = analysis?.variants?.map((v) => v.health.total) || [];
const distinct = new Set(totals);
if (distinct.size < 2 || !totals.every((t, i) => analysis.variants[i].dataSource === 'label')) {
  console.error('FAIL: expected per-label scores, got', totals, analysis?.variants?.map((v) => v.dataSource));
  process.exit(1);
}
console.log('OK: per-variant label scores', [...distinct]);
