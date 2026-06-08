import {
  normalizeOcrText,
  parseBestNutritionBlock,
  nutritionFieldCount,
  hasFullNutritionTable,
  isConfidentLabelNutrition,
} from '../scoring/nutritionParse.js';
import { preprocessLabelBuffer } from './labelPreprocess.js';

/**
 * Rebuild reading order from Tesseract line boxes (tables read top-to-bottom).
 * @param {import('tesseract.js').Page} data
 */
export function textFromTesseractLines(data) {
  const lines = data?.lines || [];
  if (!lines.length) return data?.text || '';

  const sorted = [...lines]
    .filter((l) => (l.confidence ?? 0) >= 25 && (l.text || '').trim())
    .sort((a, b) => {
      const dy = (a.bbox?.y0 ?? 0) - (b.bbox?.y0 ?? 0);
      if (Math.abs(dy) > 12) return dy;
      return (a.bbox?.x0 ?? 0) - (b.bbox?.x0 ?? 0);
    });

  return sorted.map((l) => l.text.trim()).join('\n');
}

/**
 * Score OCR output by how well it parses as a nutrition table (not raw length).
 * @param {string} text
 */
export function scoreLabelOcrText(text) {
  const norm = normalizeOcrText(text || '');
  if (!norm.trim()) return { score: 0, nutrition: null, confident: false, norm: '' };

  const nutrition = parseBestNutritionBlock(norm);
  const fields = nutritionFieldCount(nutrition);
  let score = fields * 15;
  if (hasFullNutritionTable(norm)) score += 50;
  if (/nutrition/i.test(norm) && /per\s*100/i.test(norm)) score += 20;
  if (norm.length > 80) score += Math.min(15, Math.floor(norm.length / 120));

  const confident = Boolean(nutrition && isConfidentLabelNutrition(nutrition, norm));
  if (confident) score += 40;

  return { score, nutrition, confident, norm };
}

/**
 * @param {import('tesseract.js').Worker} worker
 * @param {Buffer} buffer
 * @param {string} url
 */
async function recognizeOnce(worker, buffer, url, psm) {
  try {
    if (psm) await worker.setParameters({ tessedit_pageseg_mode: psm });
    const result = await worker.recognize(buffer);
    const data = result?.data;
    const fromLines = textFromTesseractLines(data);
    const flat = data?.text || '';
    const text = fromLines.trim().length >= flat.trim().length * 0.6 ? fromLines : flat;
    return { text, data };
  } catch (e) {
    console.warn('[EcoHealth] OCR pass failed:', url.slice(0, 80), psm, e.message || e);
    return { text: '', data: null };
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: '6' }).catch(() => {});
  }
}

/**
 * Label-focused OCR: preprocess, multiple page-seg modes, pick best parse.
 * @param {import('tesseract.js').Worker} worker
 * @param {Buffer} buffer
 * @param {string} url
 */
/**
 * @param {import('tesseract.js').Worker} worker
 * @param {Buffer} working
 * @param {string} url
 */
async function collectLabelOcrCandidates(worker, working, url) {
  /** @type {Array<{ text: string, score: number, psm: string }>} */
  const candidates = [];

  for (const psm of ['6', '4', '11', '3']) {
    const { text } = await recognizeOnce(worker, working, url, psm);
    if (!text?.trim()) continue;
    const scored = scoreLabelOcrText(text);
    candidates.push({ text: scored.norm || text, score: scored.score, psm });
  }

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      tessedit_char_whitelist:
        '0123456789.,%()+-/kcalgmgKCALGMGABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz &',
    });
    const { text } = await recognizeOnce(worker, working, url, '6');
    if (text?.trim()) {
      const scored = scoreLabelOcrText(text);
      candidates.push({ text: scored.norm || text, score: scored.score + 5, psm: 'whitelist' });
    }
  } finally {
    await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '6' }).catch(
      () => {}
    );
  }
  return candidates;
}

export async function recognizeLabelImage(worker, buffer, url) {
  /** @type {Array<{ text: string, score: number, psm: string }>} */
  let candidates = await collectLabelOcrCandidates(worker, buffer, url);

  try {
    const prepped = await preprocessLabelBuffer(buffer);
    const preCandidates = await collectLabelOcrCandidates(worker, prepped, url);
    candidates = [...candidates, ...preCandidates];
  } catch (e) {
    console.warn('[EcoHealth] label preprocess skip:', url.slice(0, 80), e.message || e);
  }

  if (!candidates.length) return '';

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (best.score >= 30) {
    console.info(
      '[EcoHealth] label OCR best:',
      url.slice(-40),
      `psm=${best.psm}`,
      `score=${best.score}`
    );
  }
  return best.text;
}
