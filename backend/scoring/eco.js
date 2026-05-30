import { scoreMaterials } from './materials.js';

const INSUFFICIENT_RATIONALE = [
  {
    text: 'No material or ingredient composition found on this listing to estimate an eco score.',
    type: 'neutral',
  },
];

/**
 * Eco score from composition only (materials / ingredients).
 * Does not use marketing claims (organic, recyclable, sustainable, etc.).
 * @param {object} merged
 */
export function buildEcoScore(merged) {
  const materialResult = scoreMaterials(merged);

  if (!materialResult) {
    return {
      total: null,
      grade: null,
      rationale: INSUFFICIENT_RATIONALE,
      insufficientData: true,
    };
  }

  let score = 50 + materialResult.scoreDelta;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade =
    score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'E';

  const rationale = [
    {
      text: 'Based on material/ingredient composition only — not product marketing or eco labels.',
      type: 'neutral',
    },
    ...materialResult.rationale,
  ];

  return { total: score, grade, rationale, insufficientData: false };
}
