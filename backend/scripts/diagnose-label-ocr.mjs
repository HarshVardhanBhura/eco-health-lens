/**
 * OCR all Maggi gallery image IDs and report parse quality.
 * Usage: node scripts/diagnose-label-ocr.mjs [id1 id2 ...]
 */
import { createWorker } from 'tesseract.js';
import { recognizeLabelImage } from '../services/labelOcr.js';
import { scoreLabelOcrText } from '../services/labelOcr.js';
import { normalizeOcrText } from '../scoring/nutritionParse.js';

const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      '71R+kuYnovL',
      '41iKDSw2b1L',
      '5184y2J7xgL',
      '51aVFXA8I0L',
      '41ot+W6BvdL',
      '41+sH1p80VL',
      '51g6JjrIUuL',
      '51E1CqaN2oL',
    ];

const worker = await createWorker('eng');
await worker.setParameters({ tessedit_pageseg_mode: '6' });

for (const id of ids) {
  const url = `https://m.media-amazon.com/images/I/${id}._SL1500_.jpg`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120' },
  });
  if (!res.ok) {
    console.log(id, 'FETCH_FAIL', res.status);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const text = await recognizeLabelImage(worker, buf, url);
  const scored = scoreLabelOcrText(text);
  console.log('---', id, '---');
  console.log('score', scored.score, 'confident', scored.confident, 'energy', scored.nutrition?.energy_kcal);
  console.log('sample:', normalizeOcrText(text).slice(0, 350).replace(/\n/g, ' | '));
}

await worker.terminate();
