/**
 * Check downloaded Amazon image resolution (run: node scripts/check-image-clarity.mjs [imageId])
 */
const imageId = process.argv[2] || '71R+kuYnovL';
const url = `https://m.media-amazon.com/images/I/${imageId}._SL1500_.jpg`;

function jpegDimensions(buf) {
  for (let i = 0; i < buf.length - 10; i++) {
    if (buf[i] !== 0xff) continue;
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
  }
  return null;
}

const res = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' },
});
if (!res.ok) {
  console.error('Fetch failed', res.status, url);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const dim = jpegDimensions(buf);
const fullRes = /_SL1500_/.test(url);
let rating = 'good';
if (!dim || dim.width < 600) rating = 'low';
else if (dim.width < 1000) rating = 'ok';

console.log('URL:', url);
console.log('Bytes:', buf.length, `(${Math.round(buf.length / 1024)} KB)`);
console.log('Dimensions:', dim ? `${dim.width}×${dim.height}` : 'unknown');
console.log('Megapixels:', dim ? ((dim.width * dim.height) / 1e6).toFixed(2) : '—');
console.log('Full-res URL (SL1500):', fullRes ? 'yes' : 'no');
console.log('Clarity rating:', rating);
console.log(
  dim?.width >= 1200
    ? 'OK for OCR — table text should be readable at full resolution.'
    : 'May be too small for reliable nutrition OCR.'
);
