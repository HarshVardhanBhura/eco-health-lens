import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const additivesDb = JSON.parse(
  readFileSync(join(__dirname, '../data/additives.json'), 'utf8')
);

/** @type {RegExp[]} */
const INGREDIENT_STOP_MARKERS = [
  /legal\s+disclaimer/i,
  /actual\s+product\s+packaging/i,
  /we recommend that you do not rely/i,
  /always read labels/i,
  /may contain more and different information/i,
  /\bwarnings?\b/i,
  /\bdirections?\s+before\s+using/i,
  /\bdirections?\s+before\s+consuming/i,
  /customer\s*care/i,
  /nutrition\s*information/i,
  /store\s+in\s+a\s+cool/i,
  /fssai\s*lic/i,
];

/**
 * Trim Amazon boilerplate, disclaimers, and directions from ingredient blobs.
 * @param {string} text
 */
export function sanitizeIngredientsText(text) {
  if (!text) return '';
  let t = text.replace(/\s+/g, ' ').trim();
  for (const re of INGREDIENT_STOP_MARKERS) {
    const m = t.search(re);
    if (m > 15) t = t.slice(0, m).trim();
  }
  return t;
}

/**
 * @param {string} part
 */
function isPlausibleIngredientPart(part) {
  const t = part.trim();
  if (t.length < 2 || t.length > 120) return false;
  const lower = t.toLowerCase();
  if (/^(warnings?|and directions|legal disclaimer|actual product)/i.test(lower)) return false;
  if (/recommended that you do not rely|always read labels/i.test(lower)) return false;
  if (/^\d+\s*&\s*\d+/.test(lower)) return false;
  if (/^[\d\s&\]]+$/.test(lower)) return false;
  return true;
}

/**
 * @param {string} text
 */
export function splitIngredients(text) {
  if (!text) return [];
  const cleaned = sanitizeIngredientsText(text);
  /** @type {string[]} */
  const parts = [];
  let current = '';
  let depth = 0;

  for (const ch of cleaned) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);

    if ((ch === ',' || ch === ';' || ch === '•' || ch === '·') && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  return parts
    .map((s) => normalizeIngredientToken(s))
    .filter((s) => s.length > 1 && isPlausibleIngredientPart(s));
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
  const tokens = splitIngredients(sanitizeIngredientsText(ingredientsText));
  /** @type {Array<{ text: string, sentiment: string, reason?: string }>} */
  const results = [];
  /** @type {Set<string>} */
  const flaggedIds = new Set();

  for (const raw of tokens) {
    const display = raw.charAt(0).toUpperCase() + raw.slice(1);
    let sentiment = 'neutral';
    let reason;

    for (const red of additivesDb.red) {
      if (red.ecoOnly) continue;
      if (matchesAlias(raw, red)) {
        if (flaggedIds.has(red.id)) {
          sentiment = 'neutral';
          break;
        }
        flaggedIds.add(red.id);
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
  /** @type {Set<string>} */
  const seenFlagIds = new Set();
  let penalty = 0;

  for (const ing of ingredients) {
    if (ing.sentiment !== 'bad') continue;
    const red = additivesDb.red.find(
      (r) => !r.ecoOnly && r.aliases.some((a) => ing.text.toLowerCase().includes(a))
    );
    if (!red || seenFlagIds.has(red.id)) continue;
    seenFlagIds.add(red.id);

    const severity = red.severity || 'medium';
    const sevPenalty = severity === 'high' ? 18 : severity === 'medium' ? 10 : 5;
    penalty += sevPenalty;
    flags.push({
      name: red.aliases[0].replace(/\b\w/g, (c) => c.toUpperCase()),
      severity,
      reason: ing.reason || red.reason || 'Flagged additive',
    });
  }

  const score = Math.max(0, Math.min(100, 100 - penalty));
  return { score, flags, ingredients };
}

export { additivesDb };
