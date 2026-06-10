const FOOD_CATEGORY_KEYWORDS = [
  'grocery',
  'food',
  'snack',
  'beverage',
  'drink',
  'breakfast',
  'cooking',
  'organic food',
  'health food',
];

const NON_FOOD_TITLE_KEYWORDS = [
  'hat',
  'cap',
  'shirt',
  't-shirt',
  'pant',
  'jeans',
  'dress',
  'shoe',
  'sandal',
  'bag',
  'wallet',
  'watch',
  'phone case',
  'cable',
  'charger',
  'toy',
  'book',
  'furniture',
  'pillow',
  'towel',
  'bucket hat',
];

const FOOD_TITLE_KEYWORDS = [
  'biscuit',
  'cookie',
  'snack',
  'cereal',
  'juice',
  'milk',
  'chocolate',
  'tea',
  'coffee',
  'rice',
  'dal',
  'atta',
  'flour',
  'oil',
  'ghee',
  'namkeen',
  'chips',
  'noodles',
  'sauce',
  'jam',
  'honey',
  'spice',
  'hing',
  'asafoetida',
  'masala',
  'pickle',
  'powder',
];

/**
 * @param {object} payload
 * @returns {'food' | 'non_food' | 'ambiguous'}
 */
export function detectProductType(payload) {
  const category = (payload.category || '').toLowerCase();
  const title = (payload.title || '').toLowerCase();
  const hints = payload.rawHints || {};

  const categoryFood = FOOD_CATEGORY_KEYWORDS.some((k) => category.includes(k));
  const titleFood = FOOD_TITLE_KEYWORDS.some((k) => title.includes(k));
  const titleNonFood = NON_FOOD_TITLE_KEYWORDS.some((k) => title.includes(k));
  const hasNutrition = Boolean(hints.hasNutrition || payload.nutrition);
  const hasIngredients = Boolean(hints.hasIngredients || (payload.ingredientsText || '').length > 10);

  if (titleNonFood && !hasNutrition && !hasIngredients && !categoryFood) return 'non_food';

  const foodSignals = [categoryFood, titleFood, hasNutrition, hasIngredients].filter(Boolean).length;

  if (foodSignals >= 2) return 'food';
  if (foodSignals === 1) return 'ambiguous';
  return 'non_food';
}
