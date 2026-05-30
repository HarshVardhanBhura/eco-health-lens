import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {{ materials: Array<{ id: string, name: string, aliases: string[], impact: number, reason: string }> } | null} */
let db = null;

function loadDb() {
  if (!db) {
    const raw = readFileSync(join(__dirname, '../data/materials.json'), 'utf8');
    db = JSON.parse(raw);
    for (const m of db.materials) {
      m.aliases = [...m.aliases].sort((a, b) => b.length - a.length);
    }
  }
  return db;
}

/**
 * @param {string} blob
 * @returns {Array<{ id: string, name: string, impact: number, reason: string, percent?: number }>}
 */
function detectFromBlob(blob) {
  const lower = blob.toLowerCase();
  /** @type {Map<string, { id: string, name: string, impact: number, reason: string, percent?: number }>} */
  const found = new Map();

  const pctRe = /(\d{1,3})\s*%\s*([a-z][a-z0-9\s\-]{2,40})/gi;
  let m;
  while ((m = pctRe.exec(lower)) !== null) {
    const percent = parseInt(m[1], 10);
    const fragment = m[2].trim();
    const mat = matchMaterial(fragment);
    if (mat) found.set(mat.id, { ...mat, percent });
  }

  for (const mat of loadDb().materials) {
    if (found.has(mat.id)) continue;
    for (const alias of mat.aliases) {
      if (alias.length < 4) continue;
      if (lower.includes(alias)) {
        found.set(mat.id, {
          id: mat.id,
          name: mat.name,
          impact: mat.impact,
          reason: mat.reason,
        });
        break;
      }
    }
  }

  return [...found.values()];
}

/**
 * @param {string} fragment
 */
function matchMaterial(fragment) {
  const lower = fragment.toLowerCase().trim();
  for (const mat of loadDb().materials) {
    for (const alias of mat.aliases) {
      if (lower.includes(alias)) return mat;
    }
  }
  return null;
}

/**
 * @param {object} merged
 * @returns {{ detected: Array<object>, scoreDelta: number, rationale: Array<{ text: string, type: string }> } | null}
 */
export function scoreMaterials(merged) {
  const blob = [merged.materialsText || '', merged.ingredientsText || ''].join(' ');

  if (!blob.trim()) return null;

  const detected = detectFromBlob(blob);
  if (detected.length === 0) return null;

  let weightedImpact = 0;
  let weightSum = 0;
  /** @type {Array<{ text: string, type: string }>} */
  const rationale = [];

  for (const d of detected) {
    const w = d.percent != null ? d.percent / 100 : 1 / detected.length;
    weightedImpact += d.impact * w;
    weightSum += w;
    const pctLabel = d.percent != null ? ` (${d.percent}%)` : '';
    const type = d.impact >= 5 ? 'positive' : d.impact <= -5 ? 'negative' : 'neutral';
    rationale.push({
      text: `${d.name}${pctLabel}: ${d.reason}`,
      type,
    });
  }

  const scoreDelta = weightSum > 0 ? weightedImpact / weightSum : 0;
  return { detected, scoreDelta, rationale };
}
