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

/**
 * Lighter preprocess for already-cropped label regions (avoid destroying table text).
 * @param {Buffer} input
 */
export async function preprocessLabelBufferSoft(input) {
  if (!input?.length) return input;

  const meta = await sharp(input).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  const minSide = Math.min(w, h);

  let pipeline = sharp(input).rotate().grayscale().normalize().sharpen({ sigma: 0.8 });
  if (minSide > 0 && minSide < 1600) {
    const scale = minSide < 800 ? 2 : 1.5;
    pipeline = pipeline.resize({
      width: Math.min(Math.round(w * scale), 3200),
      height: Math.min(Math.round(h * scale), 3200),
      fit: 'inside',
      withoutEnlargement: false,
    });
  }

  return pipeline.jpeg({ quality: 95, mozjpeg: true }).toBuffer();
}

/**
 * Amazon IN gallery images are often square composites (pack + label side by side).
 * OCR the right/bottom crops where the nutrition table usually lives.
 * @param {Buffer} input
 * @returns {Promise<Buffer[]>}
 */
export async function extractLabelRegionBuffers(input) {
  if (!input?.length) return [input];

  const meta = await sharp(input).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (w < 320 || h < 320) return [input];

  /** @type {Buffer[]} */
  const regions = [input];

  const rightX = Math.floor(w * 0.38);
  const rightW = w - rightX;
  if (rightW >= 280) {
    regions.push(
      await sharp(input)
        .extract({ left: rightX, top: 0, width: rightW, height: h })
        .toBuffer()
    );
  }

  const bottomY = Math.floor(h * 0.42);
  const bottomH = h - bottomY;
  if (bottomH >= 280) {
    regions.push(
      await sharp(input)
        .extract({ left: 0, top: bottomY, width: w, height: bottomH })
        .toBuffer()
    );
  }

  return regions;
}
