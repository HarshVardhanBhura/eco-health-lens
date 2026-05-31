/**
 * EcoHealth Lens letter grades (A–E) — internal 0–100 bands, not official Nutri-Score / Eco-Score.
 */

/** @type {Record<string, { min: number, max: number, label: string }>} */
export const GRADE_BANDS = {
  A: { min: 80, max: 100, label: 'Excellent on our scale' },
  B: { min: 65, max: 79, label: 'Good on our scale' },
  C: { min: 50, max: 64, label: 'Average / mixed' },
  D: { min: 35, max: 49, label: 'Below average' },
  E: { min: 0, max: 34, label: 'Poor on our scale' },
};

/** @type {Record<string, { summary: string, often: string[] }>} */
const HEALTH_GUIDE = {
  A: {
    summary: 'Generally strong nutrition and ingredient profile for everyday eating.',
    often: [
      'Minimally processed staples (plain grains, legumes, simple dairy)',
      'Low added sugar and salt per 100g',
      'Short ingredient lists without flagged additives',
    ],
  },
  B: {
    summary: 'Solid overall profile with only minor concerns.',
    often: [
      'Everyday packaged foods with moderate processing',
      'Balanced macros with no major red flags',
      'Few or no concerning additives',
    ],
  },
  C: {
    summary: 'Typical treat or packaged food — fine occasionally, not a daily default.',
    often: [
      'Chocolate, biscuits, sweetened snacks',
      'Moderate-to-high sugar or fat per 100g',
      'Some processing or emulsifiers in ingredients',
    ],
  },
  D: {
    summary: 'Several nutritional or ingredient concerns worth limiting.',
    often: [
      'High sugar or salt packaged foods',
      'More processed recipes with additives',
      'Low fibre / high energy density snacks',
    ],
  },
  E: {
    summary: 'Weak profile across macros, processing, or additives.',
    often: [
      'Ultra-processed snacks and sweets',
      'Many flagged additives or sweeteners',
      'Very high sugar, salt, or saturated fat per 100g',
    ],
  },
};

/** @type {Record<string, { summary: string, often: string[] }>} */
const ECO_GUIDE = {
  A: {
    summary: 'Composition suggests lower-impact materials and simpler makeup.',
    often: [
      'Paper, cardboard, glass, or metal-heavy packaging',
      'Natural fibres and simple material lists',
      'Few synthetic or mixed composites',
    ],
  },
  B: {
    summary: 'Reasonable material choices with limited synthetic burden.',
    often: [
      'Mixed packaging with recyclable components',
      'Mostly benign materials in product description',
    ],
  },
  C: {
    summary: 'Typical consumer product with mixed material impact.',
    often: [
      'Plastic plus other materials in packaging or product',
      'Standard synthetic blends in textiles or housings',
    ],
  },
  D: {
    summary: 'Heavier reliance on plastics or hard-to-recycle materials.',
    often: [
      'Multi-layer plastic packaging',
      'Synthetic dominant material lists',
    ],
  },
  E: {
    summary: 'High synthetic or unclear material footprint on the listing.',
    often: [
      'Heavy plastic / composite materials',
      'Limited recyclable or natural content stated',
    ],
  },
};

/**
 * @param {string} grade
 */
export function normalizeGrade(grade) {
  if (!grade) return '';
  return String(grade).trim().charAt(0).toUpperCase();
}

/**
 * @param {string} grade
 */
export function getBandLabel(grade) {
  const g = normalizeGrade(grade);
  const band = GRADE_BANDS[g];
  if (!band) return '';
  return `Score ${band.min}–${band.max}`;
}

/**
 * @param {'health' | 'eco'} type
 * @param {string} grade
 */
export function getGradeGuide(type, grade) {
  const g = normalizeGrade(grade);
  const band = GRADE_BANDS[g];
  const guide = type === 'eco' ? ECO_GUIDE[g] : HEALTH_GUIDE[g];
  if (!band || !guide) return null;
  return {
    grade: g,
    band,
    summary: guide.summary,
    often: guide.often,
    disclaimer:
      'EcoHealth Lens grade — not Nutri-Score, EU Eco-Score, or any certification.',
  };
}
