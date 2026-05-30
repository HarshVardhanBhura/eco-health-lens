import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const additivesDb = JSON.parse(
  readFileSync(join(__dirname, '../data/additives.json'), 'utf8')
);

/**
 * @param {string} text
 */
export function splitIngredients(text) {
  if (!text) return [];
  return text
    .split(/[,;•·]/)
    .map((s) => normalizeIngredientToken(s))
    .filter((s) => s.length > 1);
}

/**
 * @param {string} token
 */
function normalizeIngredientToken(token) {
  return token
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} token
 * @param {{ aliases: string[] }} entry
 */
function matchesAlias(token, entry) {
  return entry.aliases.some((a) => {
    const alias = a.toLowerCase();
    if (alias.length < 4) return token === alias;
    return token.includes(alias);
  });
}

/**
 * @param {string} ingredientsText
 */
export function parseIngredientsWithSentiment(ingredientsText) {
  const tokens = splitIngredients(ingredientsText);
  /** @type {Array<{ text: string, sentiment: string, reason?: string }>} */
  const results = [];

  for (const raw of tokens) {
    const display = raw.charAt(0).toUpperCase() + raw.slice(1);
    let sentiment = 'neutral';
    let reason;

    for (const red of additivesDb.red) {
      if (matchesAlias(raw, red)) {
        sentiment = 'bad';
        reason = red.reason;
        break;
      }
    }

    if (sentiment === 'neutral') {
      for (const green of additivesDb.green) {
        if (matchesAlias(raw, green)) {
          sentiment = 'good';
          reason = green.reason;
          break;
        }
      }
    }

    results.push({ text: display, sentiment, reason });
  }

  return results;
}

/**
 * @param {string} ingredientsText
 */
export function scoreAdditives(ingredientsText) {
  const ingredients = parseIngredientsWithSentiment(ingredientsText);
  const flags = [];
  let penalty = 0;

  for (const ing of ingredients) {
    if (ing.sentiment !== 'bad') continue;
    const red = additivesDb.red.find((r) =>
      r.aliases.some((a) => ing.text.toLowerCase().includes(a))
    );
    const severity = red?.severity || 'medium';
    const sevPenalty = severity === 'high' ? 18 : severity === 'medium' ? 10 : 5;
    penalty += sevPenalty;
    flags.push({
      name: ing.text,
      severity,
      reason: ing.reason || 'Flagged additive',
    });
  }

  const score = Math.max(0, Math.min(100, 100 - penalty));
  return { score, flags, ingredients };
}

export { additivesDb };
