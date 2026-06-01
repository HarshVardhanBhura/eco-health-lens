import sharp from 'sharp';

/**
 * Prepare pack label photos for Tesseract (contrast, size, grayscale).
 * Mirrors extension canvas preprocess; runs again on server buffers for consistency.
 * @param {Buffer} input
 * @returns {Promise<Buffer>}
 */
export async function preprocessLabelBuffer(input) {
  if (!input?.length) return input;

  const meta = await sharp(input).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;

  let pipeline = sharp(input).rotate().grayscale().normalize().sharpen({ sigma: 1.1 });

  const minSide = Math.min(w, h);
  if (minSide > 0 && minSide < 1400) {
    const scale = minSide < 700 ? 2.5 : minSide < 1000 ? 2 : 1.5;
    pipeline = pipeline.resize({
      width: Math.min(Math.round(w * scale), 2800),
      height: Math.min(Math.round(h * scale), 3600),
      fit: 'inside',
      withoutEnlargement: false,
    });
  }

  return pipeline
    .linear(1.25, -(128 * 0.15))
    .threshold(165, { grayscale: true })
    .jpeg({ quality: 94, mozjpeg: true })
    .toBuffer();
}
