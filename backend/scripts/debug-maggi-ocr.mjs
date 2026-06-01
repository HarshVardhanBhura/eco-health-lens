import {
  parseBestNutritionBlock,
  nutritionFieldCount,
  isConfidentLabelNutrition,
  hasPackLabelSection,
  normalizeOcrText,
} from '../scoring/nutritionParse.js';

const url =
  'https://m.media-amazon.com/images/I/71R+kuYnovL._SL1500_.jpg';

let createWorker;
try {
  ({ createWorker } = await import('tesseract.js'));
} catch (e) {
  console.error('tesseract not installed', e.message);
  process.exit(1);
}

const res = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' },
});
if (!res.ok) {
  console.error('fetch failed', res.status);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
console.log('image bytes', buf.length);

const worker = await createWorker('eng');
await worker.setParameters({ tessedit_pageseg_mode: '6' });
const { data } = await worker.recognize(buf);
await worker.terminate();

const raw = data?.text || '';
const text = normalizeOcrText(raw);
console.log('--- OCR text (first 2000 chars) ---');
console.log(text.slice(0, 2000));
console.log('--- end ---');

const parsed = parseBestNutritionBlock(text);
console.log('parsed', parsed);
console.log('fields', nutritionFieldCount(parsed));
console.log('pack section', hasPackLabelSection(text));
console.log('confident', isConfidentLabelNutrition(parsed, text));
