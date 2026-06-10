/**
 * Amazon IN content script (single file — no ES modules).
 * EcoHealth Lens bundle v1.0.9
 */
console.info('[EcoHealth] script injected on', location.href);

function isProductPage() {
  return /\/(?:dp\/|gp\/product\/)/i.test(location.pathname);
}

// --- extractors/amazon-in.js ---
const ASIN_REGEX = /(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})/i;

function queryFirst(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function extractAsin() {
  const match = window.location.pathname.match(ASIN_REGEX);
  if (match) return match[1].toUpperCase();
  const meta = document.querySelector('input[name="ASIN"], #ASIN');
  if (meta && 'value' in meta) return String(meta.value).toUpperCase();
  return '';
}

function findTitleElement(selectors) {
  return queryFirst(
    selectors.title || [
      '#productTitle',
      '#title',
      '#productTitle_feature_div h1',
      '#titleSection h1',
      '#centerCol h1',
      'h1.a-size-large',
    ]
  );
}

function extractTitle(selectors) {
  const el = findTitleElement(selectors);
  return el ? normalizeText(el.textContent) : '';
}

function extractCategory(selectors) {
  const el = queryFirst(selectors.breadcrumbs || ['#wayfinding-breadcrumbs_feature_div']);
  if (!el) return '';
  return normalizeText(el.textContent);
}

function findLabeledValue(haystack, labels) {
  const lower = haystack.toLowerCase();
  for (const label of labels) {
    const idx = lower.indexOf(label.toLowerCase());
    if (idx === -1) continue;
    const slice = haystack.slice(idx + label.length);
    const cleaned = slice.replace(/^[\s:：\-–]+/, '').split('\n')[0].trim();
    if (cleaned.length > 2 && cleaned.length < 200) return cleaned;
  }
  return '';
}

function extractBarcode(selectors) {
  const containers = [
    ...(selectors.detailBullets || []),
    ...(selectors.techSpec || []),
    ...(selectors.productDetails || []),
  ];
  let blob = '';
  for (const sel of containers) {
    document.querySelectorAll(sel).forEach((el) => {
      blob += '\n' + (el.textContent || '');
    });
  }
  const labels = selectors.barcodeLabels || ['ean', 'upc', 'barcode', 'gtin'];
  for (const label of labels) {
    const re = new RegExp(`${label}[^\\d]*(\\d{8,14})`, 'i');
    const m = blob.match(re);
    if (m) return m[1];
  }
  const any = blob.match(/\b(\d{13}|\d{12}|\d{8})\b/);
  return any ? any[1] : '';
}

function sanitizePageIngredients(text) {
  if (!text) return '';
  let t = text.replace(/\s+/g, ' ').trim();
  const stops = [
    /legal\s+disclaimer/i,
    /actual\s+product\s+packaging/i,
    /we recommend that you do not rely/i,
    /\bwarnings?\b/i,
    /\bdirections?\s+before\s+(using|consuming)/i,
    /nutrition\s*information/i,
    /customer\s*care/i,
  ];
  for (const re of stops) {
    const m = t.search(re);
    if (m > 15) t = t.slice(0, m).trim();
  }
  return t;
}

function extractIngredientsFromText(text) {
  const lower = text.toLowerCase();
  const markers = ['ingredients:', 'ingredients', 'contains:'];
  for (const m of markers) {
    const idx = lower.indexOf(m);
    if (idx === -1) continue;
    let rest = text.slice(idx + m.length).trim();
    const stop = rest.search(
      /\n\s*(allergen|nutrition|storage|directions|manufactured)|legal\s+disclaimer|warnings?\b|directions?\s+before/i
    );
    if (stop > 0) rest = rest.slice(0, stop);
    return sanitizePageIngredients(normalizeText(rest));
  }
  return '';
}

function extractIngredients(selectors) {
  const parts = [];
  const info = queryFirst(selectors.importantInfo || ['#important-information']);
  if (info) parts.push(info.textContent || '');

  document
    .querySelectorAll(
      '#feature-bullets li, #productFactsDesktopExpander, #productDescription, #aplus_feature_div'
    )
    .forEach((el) => {
      const t = (el.textContent || '').toLowerCase();
      if (/ingredient|composition|contains|made from|hing|asafoetida/.test(t)) {
        parts.push(el.textContent || '');
      }
    });

  for (const sel of selectors.productDetails || []) {
    document.querySelectorAll(sel).forEach((el) => {
      parts.push(el.textContent || '');
    });
  }

  const blob = parts.join('\n');
  return extractIngredientsFromText(blob) || findLabeledValue(blob, selectors.ingredientKeywords || ['ingredients']);
}

function parseNutritionTable(text) {
  const nutrition = { per: '100g' };
  const patterns = [
    [/energy[:\s]*(?:\([^)]*\))?[:\s]*([\d.]+)\s*kcal/i, 'energy_kcal'],
    [/protein[:\s]*(?:\([^)]*\))?[:\s]*([\d.]+)\s*g/i, 'protein_g'],
    [/carbohydrate[s]?[:\s]*(?:\([^)]*\))?[:\s]*([\d.]+)\s*g/i, 'carbs_g'],
    [/total\s+sugars?[:\s]*([\d.]+)\s*g/i, 'sugar_g'],
    [/total\s+fat[:\s]*([\d.]+)\s*g/i, 'fat_g'],
    [/saturat(?:ed|es)?\s*fat[:\s]*([\d.]+)\s*g/i, 'saturated_fat_g'],
    [/fibre|fiber[:\s]*([\d.]+)\s*g/i, 'fiber_g'],
    [/sodium[:\s]*([\d.]+)\s*mg/i, 'sodium_mg'],
    [/energy[:\s]+([\d.]+)\s*kcal/i, 'energy_kcal'],
  ];
  for (const [re, key] of patterns) {
    const m = text.match(re);
    if (m && nutrition[key] == null) nutrition[key] = parseFloat(m[1]);
  }
  if (text.match(/per\s+serving/i)) nutrition.per = 'serving';
  return nutrition;
}

function scoreGalleryImage(alt, url) {
  let s = 0;
  const a = (alt || '').toLowerCase();
  const u = (url || '').toLowerCase();
  if (/nutrition|ingredient|label|facts|back|barcode|composition|allergen|per\s*100/i.test(a)) s += 10;
  if (/nutrition(?:al)?\s*information|per\s*100\s*g|net\s*quantity|fssai|masala/i.test(a))
    s += 12;
  if (/instant\s+noodles|back\s*of|barcode/i.test(a)) s += 6;
  if (/mega\s*pack|front\s*(?:of\s*)?pack|hero\s*image|lifestyle/i.test(a)) s -= 12;
  if (/cranberr|fruit\s*(?:&|and)\s*nut|intense|70\s*%?\s*dark|bournville/i.test(a)) s += 8;
  const flavourHits = [
    /cranberr/,
    /fruit\s*(?:&|and)\s*nut/,
    /intense|70\s*%?\s*dark/,
  ].filter((re) => re.test(a)).length;
  if (flavourHits >= 2) s += 14;
  if (a.length > 25) s += 2;
  if (/\.jpg|\.png|\.webp/.test(u)) s += 1;
  return s;
}

/**
 * @param {string} url
 */
function amazonImageId(url) {
  if (!url) return null;
  const m = url.match(/\/images\/I\/([A-Za-z0-9+_-]+)/i);
  if (!m) return null;
  return m[1].replace(/\._.*$/, '');
}

/**
 * Upgrade thumb URLs (_SX30_, etc.) to full gallery resolution for OCR.
 * @param {string} url
 */
function toFullResAmazonImageUrl(url) {
  if (!url || !url.startsWith('http')) return url;
  const id = amazonImageId(url);
  if (!id) return url;

  if (/_SL1[0-9]{3,4}|_AC_SL1[0-9]{3}/i.test(url) && !/_SX[1-9]\d?_|_SX\d+_SY/i.test(url)) {
    return url.replace(/\.webp(\?.*)?$/i, '.jpg$1');
  }

  const host = url.includes('media-amazon.com')
    ? url.match(/^https?:\/\/[^/]+/)?.[0] || 'https://m.media-amazon.com'
    : 'https://m.media-amazon.com';

  return `${host}/images/I/${id}._SL1500_.jpg`;
}

/**
 * URL of the gallery thumb the user selected (not stale #landingImage).
 * @param {HTMLImageElement} [clickedImg]
 */
function getActiveGalleryImageUrl(clickedImg) {
  if (clickedImg?.tagName === 'IMG') {
    const direct = resolveAmazonImageUrl(clickedImg);
    if (direct) return direct;
  }

  const thumbSelectors = [
    '#altImages li.selected img',
    '#altImages li.a-button-selected img',
    '#altImages li.imageSelected img',
    '#altImages .item.selected img',
    '.imageThumbnail.selected img',
    '#ivThumbs .ivThumb.ivThumbSelected img',
    '#ivThumbs .ivSelected img',
    '#ivImageBlock img',
  ];
  for (const sel of thumbSelectors) {
    const img = document.querySelector(sel);
    if (!img) continue;
    const url = resolveAmazonImageUrl(img);
    if (url) return url;
  }

  const landing = document.querySelector('#landingImage, #imgBlkFront');
  return landing ? resolveAmazonImageUrl(landing) : '';
}

function resolveAmazonImageUrl(img) {
  let url = img.getAttribute('data-old-hires') || img.src || '';
  const dynamic = img.getAttribute('data-a-dynamic-image');
  if (dynamic) {
    try {
      const obj = JSON.parse(dynamic);
      const keys = Object.keys(obj).filter((k) => k.startsWith('http'));
      if (keys.length) {
        const jpgKeys = keys.filter((k) => /\.jpe?g(\?|$)/i.test(k));
        const pool = jpgKeys.length ? jpgKeys : keys.filter((k) => !/\.webp(\?|$)/i.test(k));
        const sorted = (pool.length ? pool : keys).sort((a, b) => b.length - a.length);
        url = sorted[0];
      }
    } catch {
      /* ignore */
    }
  }
  if (url && /\.webp(\?|$)/i.test(url)) {
    url = url.replace(/\.webp(\?.*)?$/i, '.jpg$1');
  }
  url = toFullResAmazonImageUrl(url);
  return url && url.startsWith('http') ? url : '';
}

function extractProductImages() {
  /** @type {Map<string, { url: string, alt: string, priority?: number, score: number }>} */
  const byImageId = new Map();

  const addImage = (url, alt, extraPriority = 0) => {
    if (!url || url.includes('sprite') || url.includes('gif') || url.includes('.svg')) return;
    const full = toFullResAmazonImageUrl(url);
    const id = amazonImageId(full) || full;
    const score = scoreGalleryImage(alt, full) + extraPriority;
    const prev = byImageId.get(id);
    if (!prev || score > prev.score || full.length > prev.url.length) {
      byImageId.set(id, {
        url: full,
        alt: alt || prev?.alt || '',
        priority: Math.max(prev?.priority || 0, extraPriority),
        score,
      });
    }
  };

  document
    .querySelectorAll(
      '#altImages img, #imageBlock img, #imgTagWrapperId img, #ivImagesTab img, .imageThumbnail img'
    )
    .forEach((img) => {
      const url = resolveAmazonImageUrl(img);
      const alt = (img.alt || img.getAttribute('title') || '').trim();
      addImage(url, alt, 0);
    });

  const landing = document.querySelector('#landingImage, #imgBlkFront');
  const landingUrl = landing ? resolveAmazonImageUrl(landing) : '';
  if (landingUrl) {
    const landingAlt = (landing?.alt || '').trim() || 'Main product image';
    let landingPriority = 200;
    if (/nutrition|ingredient|label|facts|back|barcode|per\s*100|nutritional/i.test(landingAlt)) {
      landingPriority = 500;
    }
    if (/_SL1[0-9]{3}/i.test(landingUrl)) landingPriority += 100;
    addImage(landingUrl, landingAlt, landingPriority);
  }

  return [...byImageId.values()]
    .sort(
      (a, b) =>
        (b.priority || 0) + b.score - ((a.priority || 0) + a.score)
    )
    .slice(0, 12)
    .map(({ url, alt, priority }) => ({ url, alt, priority }));
}

function extractNutritionPageText(selectors) {
  const keywords = selectors.nutritionKeywords || ['nutrition'];
  let blob = '';

  const addIfNutrition = (text) => {
    const t = (text || '').toLowerCase();
    if (
      keywords.some((k) => t.includes(k.toLowerCase())) ||
      (/energy|kcal/i.test(t) && /protein|carbohydrate|sodium/i.test(t))
    ) {
      blob += '\n' + text;
    }
  };

  document.querySelectorAll('table').forEach((table) => addIfNutrition(table.textContent || ''));
  document
    .querySelectorAll(
      '#important-information, #productDetails_feature_div, #aplus_feature_div, #productDescription, #productFactsDesktopExpander'
    )
    .forEach((el) => addIfNutrition(el.textContent || ''));

  document.querySelectorAll('h1, h2, h3, h4, h5, strong, b, span').forEach((el) => {
    if (!/nutrition|nutritional/i.test(el.textContent || '')) return;
    const block = el.closest('div, section, table, li') || el.parentElement;
    if (block) addIfNutrition(block.textContent || '');
  });

  return blob.trim().slice(0, 12000);
}

function extractNutrition(selectors) {
  const blob = extractNutritionPageText(selectors);
  const parsed = parseNutritionTable(blob);
  return Object.keys(parsed).filter((k) => k !== 'per' && parsed[k] != null).length > 0
    ? parsed
    : null;
}

function extractMaterials(selectors) {
  const parts = [];
  const titleEl = findTitleElement(selectors);
  if (titleEl) parts.push(titleEl.textContent || '');

  const containers = [
    ...(selectors.detailBullets || []),
    ...(selectors.techSpec || []),
    ...(selectors.productDetails || []),
  ];
  for (const sel of containers) {
    document.querySelectorAll(sel).forEach((el) => {
      parts.push(el.textContent || '');
    });
  }

  document.querySelectorAll('#feature-bullets li').forEach((el) => {
    const t = (el.textContent || '').toLowerCase();
    if (/material|fabric|composition|cotton|polyester|leather|wood|metal|plastic|nylon|wool|linen|hemp|acrylic|spandex|silicone|steel|glass|rubber/.test(t)) {
      parts.push(el.textContent || '');
    }
  });

  const blob = parts.join('\n');
  const labeled = findLabeledValue(blob, [
    'material',
    'materials',
    'material composition',
    'fabric type',
    'fabric',
    'composition',
    'outer material',
    'shell material',
    'sole material',
    'fill material',
  ]);

  return normalizeText(labeled || blob).slice(0, 4000);
}

function extractPackWeight(selectors) {
  const title = extractTitle(selectors);
  const fromTitle = title.match(/\b(\d+(?:\.\d+)?)\s*(?:g|gm|gram|grams|kg|ml|l)\b/i);
  if (fromTitle) {
    let n = parseFloat(fromTitle[1]);
    const unit = fromTitle[0].toLowerCase();
    if (unit.includes('kg')) n *= 1000;
    if (n > 0 && n < 50000) return Math.round(n);
  }

  let blob = '';
  for (const sel of [
    ...(selectors.detailBullets || []),
    ...(selectors.productDetails || []),
    '#productOverview_feature_div',
  ]) {
    document.querySelectorAll(sel).forEach((el) => {
      blob += '\n' + (el.textContent || '');
    });
  }

  const labeled = findLabeledValue(blob, [
    'net quantity',
    'item weight',
    'package weight',
    'net weight',
    'weight',
  ]);
  const m = (labeled || blob).match(/(\d+(?:\.\d+)?)\s*(?:g|gm|gram|grams|kg)\b/i);
  if (m) {
    let n = parseFloat(m[1]);
    if (m[0].toLowerCase().includes('kg')) n *= 1000;
    if (n > 0 && n < 50000) return Math.round(n);
  }
  return undefined;
}

function extractRawHints(ingredientsText, nutrition, materialsText) {
  return {
    hasNutrition: Boolean(nutrition && Object.keys(nutrition).length > 1),
    hasIngredients: ingredientsText.length > 10,
    hasMaterials: materialsText.length > 8,
  };
}

const MAX_OCR_FETCH = 3;
const MAX_OCR_BYTES = 2_500_000;

/**
 * @param {Blob} blob
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve({ base64, mimeType: blob.type || 'image/jpeg' });
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Upscale + contrast for small label text (Tesseract reads tables better).
 * @param {Blob} blob
 */
/**
 * @param {Blob} blob
 * @param {string} [url]
 */
async function measureImageBlob(blob, url = '') {
  try {
    const bmp = await createImageBitmap(blob);
    const width = bmp.width;
    const height = bmp.height;
    bmp.close();
    const bytes = blob.size;
    const fullRes = /_SL1[0-9]{3,4}|_AC_SL1[0-9]{3}/i.test(url);
    const thumb = /_SX\d+_|_SY\d+_|_AC_US\d+/i.test(url);
    let rating = 'good';
    if (width < 600 || height < 600 || thumb) rating = 'low';
    else if (width < 1000 || height < 1000) rating = 'ok';
    return {
      width,
      height,
      bytes,
      fullRes,
      thumb,
      rating,
      megapixels: Math.round((width * height) / 10000) / 100,
    };
  } catch {
    return { width: 0, height: 0, bytes: blob.size, fullRes: false, rating: 'unknown' };
  }
}

async function preprocessImageForOcr(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const minSide = Math.min(bmp.width, bmp.height);
    const scale = minSide < 700 ? 2.5 : minSide < 1000 ? 2 : minSide < 1400 ? 1.35 : 1;
    const w = Math.min(Math.round(bmp.width * scale), 2800);
    const h = Math.min(Math.round(bmp.height * scale), 3600);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return blob;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.filter = 'contrast(1.35) saturate(0.2)';
    ctx.drawImage(bmp, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const avg = (d[i] + d[i + 1] + d[i + 2]) / 3;
      const v = avg > 175 ? 255 : avg < 88 ? 0 : avg;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);
    bmp.close();
    const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94));
    return out || blob;
  } catch {
    return blob;
  }
}

function isNutritionGalleryImage(alt, url) {
  const a = (alt || '').toLowerCase();
  const u = (url || '').toLowerCase();
  return (
    /nutrition|nutritional|per\s*100|ingredient|label|facts|back\s*of|barcode|fssai/i.test(a) ||
    /nutrition|ingredient|label|back/.test(u)
  );
}

function isIngredientsGalleryImage(alt) {
  const a = (alt || '').toLowerCase();
  return /ingredient|composition|back\s*of|barcode|allergen/i.test(a);
}

/**
 * Rank gallery images for automatic nutrition-table OCR (no user click).
 * @param {Array<{ url: string, alt?: string, priority?: number }>} images
 * @param {string} [landingImageUrl]
 */
function rankImagesForAutoNutritionOcr(images, landingImageUrl) {
  const landingId = amazonImageId(landingImageUrl || '');
  const scored = (images || []).map((img) => {
    const url = toFullResAmazonImageUrl(img.url);
    const nutritionScore = scoreGalleryImage(img.alt, url);
    const isNutrition =
      isNutritionGalleryImage(img.alt, url) || nutritionScore >= 18;
    return {
      url,
      alt: img.alt || '',
      priority: img.priority || 0,
      nutritionScore,
      isNutrition,
      isLanding: amazonImageId(url) === landingId,
    };
  });

  let nutrition = scored
    .filter((i) => i.isNutrition)
    .sort((a, b) => b.nutritionScore - a.nutritionScore);

  if (!nutrition.length) {
    nutrition = scored
      .filter((i) => !i.isLanding)
      .sort((a, b) => b.nutritionScore - a.nutritionScore);
  }

  const ingredients = scored
    .filter((i) => !i.isLanding && isIngredientsGalleryImage(i.alt))
    .sort((a, b) => b.nutritionScore - a.nutritionScore);

  const gallerySweep = scored
    .filter((i) => !i.isLanding)
    .sort((a, b) => b.nutritionScore - a.nutritionScore);

  return { nutrition, ingredients, landingId, gallerySweep };
}

/**
 * Fetch gallery images in-browser (Amazon often blocks server-side image fetch).
 * @param {Array<{ url: string, alt?: string }>} images
 */
/**
 * @param {Array<{ url: string, alt?: string, priority?: number }>} images
 * @param {string} [landingImageUrl]
 */
async function fetchImagesForOcr(images, landingImageUrl, options = {}) {
  const selectedOnly = options.selectedOnly === true;
  const autoNutrition = options.autoNutrition === true;
  /** @type {Array<{ url: string, alt: string, priority: number, nutritionImage?: boolean }>} */
  const queue = [];

  if (selectedOnly && landingImageUrl) {
    queue.push({
      url: toFullResAmazonImageUrl(landingImageUrl),
      alt: 'Main viewer (selected)',
      priority: 2000,
      nutritionImage: true,
    });
  } else if (autoNutrition) {
    const { nutrition, ingredients, landingId, gallerySweep } = rankImagesForAutoNutritionOcr(
      images,
      landingImageUrl
    );

    // Label-first: only queue likely nutrition-table images (max 3). Skipping
    // generic gallery sweeps keeps OCR within Render's ~30s request limit.
    for (const img of nutrition.slice(0, 3)) {
      queue.push({
        url: img.url,
        alt: img.alt,
        priority: 5000 + img.nutritionScore,
        nutritionImage: true,
      });
    }

    if (!queue.length) {
      for (const img of gallerySweep.slice(0, 2)) {
        const id = amazonImageId(img.url);
        if (queue.some((q) => amazonImageId(q.url) === id)) continue;
        queue.push({
          url: img.url,
          alt: img.alt,
          priority: 3500 + img.nutritionScore,
          nutritionImage: isNutritionGalleryImage(img.alt, img.url),
        });
      }
    }

    for (const img of gallerySweep
      .filter((i) => /barcode|back\s*of|ean|gtin/i.test(i.alt || ''))
      .slice(0, 2)) {
      const id = amazonImageId(img.url);
      if (queue.some((q) => amazonImageId(q.url) === id)) continue;
      queue.push({
        url: img.url,
        alt: img.alt,
        priority: 4800,
        nutritionImage: false,
        barcodeImage: true,
      });
    }

    for (const img of ingredients.slice(0, 1)) {
      const id = amazonImageId(img.url);
      if (queue.some((q) => amazonImageId(q.url) === id)) continue;
      queue.push({
        url: img.url,
        alt: img.alt,
        priority: 2500,
        nutritionImage: false,
      });
    }

    const landingIsNutrition =
      landingImageUrl &&
      isNutritionGalleryImage('', landingImageUrl) &&
      scoreGalleryImage('', landingImageUrl) >= 18;

    if (landingImageUrl && (landingIsNutrition || !nutrition.length)) {
      const lid = amazonImageId(landingImageUrl);
      if (!queue.some((q) => amazonImageId(q.url) === lid)) {
        queue.push({
          url: toFullResAmazonImageUrl(landingImageUrl),
          alt: 'Main viewer',
          priority: landingIsNutrition ? 4500 : 800,
          nutritionImage: Boolean(landingIsNutrition),
        });
      }
    }

    if (queue.length) {
      const targetIds = queue
        .filter((q) => q.nutritionImage)
        .map((q) => amazonImageId(q.url))
        .filter(Boolean);
      console.info(
        '[EcoHealth] Auto nutrition OCR — gallery targets:',
        targetIds.join(', ') || '(non-landing gallery sweep)'
      );
    }
  } else {
    if (landingImageUrl) {
      queue.push({
        url: toFullResAmazonImageUrl(landingImageUrl),
        alt: 'Main viewer (selected)',
        priority: 2000,
      });
    }

    for (const img of images || []) {
      queue.push({
        url: toFullResAmazonImageUrl(img.url),
        alt: img.alt || '',
        priority: img.priority || scoreGalleryImage(img.alt, img.url),
      });
    }
  }

  const seen = new Set();
  const ranked = queue
    .filter((item) => {
      const id = amazonImageId(item.url) || item.url;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => b.priority - a.priority);

  /** @type {Array<{ base64: string, mimeType: string, alt: string, url: string }>} */
  const buffers = [];

  const maxFetch = selectedOnly ? 1 : MAX_OCR_FETCH;
  const maxBuffers = selectedOnly ? 1 : autoNutrition ? 3 : 3;

  for (const img of ranked.slice(0, maxFetch)) {
    if (buffers.length >= maxBuffers) break;
    try {
      const res = await fetch(img.url, { credentials: 'same-origin', mode: 'cors' });
      if (!res.ok) continue;
      let blob = await res.blob();
      if (blob.size < 400 || blob.size > MAX_OCR_BYTES) continue;
      const type = blob.type || 'image/jpeg';
      if (/webp/i.test(type) || /\.webp(\?|$)/i.test(img.url || '')) continue;
      if (!/^image\/(jpeg|jpg|png|gif)/i.test(type)) continue;
      const nutritionImage = Boolean(
        img.nutritionImage ||
          selectedOnly ||
          isNutritionGalleryImage(img.alt, img.url)
      );
      const clarityBefore = await measureImageBlob(blob, img.url);
      // Label contrast/threshold runs on backend (sharp) — double preprocessing breaks table OCR.
      const clarity = clarityBefore;
      const { base64, mimeType } = await blobToBase64(blob);
      const id = amazonImageId(img.url) || img.url.slice(-24);
      console.info('[EcoHealth] image clarity:', id, {
        ...clarity,
        preprocessed: nutritionImage,
        before: nutritionImage ? `${clarityBefore.width}×${clarityBefore.height}` : undefined,
      });
      if (clarity.rating === 'low' || !clarity.fullRes) {
        console.warn(
          '[EcoHealth] Low-resolution image for OCR — expect poor label reads:',
          img.url.slice(-72)
        );
      }
      buffers.push({
        base64,
        mimeType,
        alt: img.alt || '',
        url: img.url,
        nutritionImage,
        barcodeImage: Boolean(img.barcodeImage),
        clarity,
      });
    } catch (e) {
      console.warn('[EcoHealth] gallery image fetch failed', img.url?.slice(0, 80), e);
    }
  }
  if (buffers.length) {
    console.table(
      buffers.map((b) => ({
        image: amazonImageId(b.url) || '—',
        px: `${b.clarity?.width || '?'}×${b.clarity?.height || '?'}`,
        kb: Math.round((b.clarity?.bytes || 0) / 1024),
        fullRes: b.clarity?.fullRes ? 'yes' : 'no',
        rating: b.clarity?.rating || '?',
      }))
    );
  }
  return buffers.length ? buffers : undefined;
}

function buildPayload(selectorRegistry) {
  const asin = extractAsin();
  if (!asin) return null;

  const title = extractTitle(selectorRegistry);
  const category = extractCategory(selectorRegistry);
  const ingredientsText = extractIngredients(selectorRegistry);
  const nutrition = extractNutrition(selectorRegistry);
  const nutritionPageText = extractNutritionPageText(selectorRegistry) || undefined;
  const barcode = extractBarcode(selectorRegistry);
  const materialsText = extractMaterials(selectorRegistry);
  const packWeightG = extractPackWeight(selectorRegistry);
  const productImages = extractProductImages();
  const selectedImageUrl = getActiveGalleryImageUrl() || undefined;
  const rawHints = extractRawHints(ingredientsText, nutrition, materialsText);

  return {
    retailer: 'amazon_in',
    asin,
    url: window.location.href,
    title,
    category,
    barcode: barcode || undefined,
    ingredientsText: ingredientsText || undefined,
    materialsText: materialsText || undefined,
    packWeightG: packWeightG || undefined,
    productImages: productImages.length ? productImages : undefined,
    selectedImageUrl: selectedImageUrl || undefined,
    nutrition: nutrition || undefined,
    nutritionPageText,
    rawHints,
  };
}

// --- ui/badge.js ---
function scoreBand(score) {
  if (score == null || Number.isNaN(score)) return 'loading';
  if (score < 40) return 'band-low';
  if (score < 70) return 'band-mid';
  return 'band-high';
}

function shouldFetchImagesForOcr(payload) {
  if (!payload) return false;
  if (payload.nutrition || (payload.ingredientsText || '').length > 10) return true;
  if (payload.rawHints?.hasNutrition || payload.rawHints?.hasIngredients) return true;
  const title = (payload.title || '').toLowerCase();
  const category = (payload.category || '').toLowerCase();
  const nonFood = /\b(hat|cap|shirt|pant|jeans|dress|shoe|sandal|bag|wallet|watch|toy|book|furniture|pillow|towel|cable|charger)\b/i;
  const food =
    /\b(biscuit|cookie|snack|cereal|juice|milk|chocolate|tea|coffee|rice|dal|atta|flour|oil|ghee|namkeen|chips|noodles|sauce|jam|honey|spice|masala|pickle|powder)\b/i;
  const categoryFood = /grocery|food|snack|beverage|drink|breakfast|cooking/.test(category);
  if (nonFood.test(title) && !food.test(title) && !categoryFood) return false;
  if (food.test(title) || categoryFood) return true;
  return true;
}

function displayScore(result, phase = 'done') {
  if (!result) {
    if (phase === 'loading') {
      return { score: '…', band: 'loading', label: 'Analyzing…', icon: '…' };
    }
    return { score: '!', band: 'band-mid', label: 'Unavailable', icon: '⚠' };
  }
  const isFood = result.productType === 'food' || result.productType === 'ambiguous';
  if (isFood && result.health) {
    return {
      score: String(result.health.total),
      band: scoreBand(result.health.total),
      label: 'Health',
      icon: '🍎',
    };
  }
  if (result.eco) {
    if (result.eco.insufficientData || result.eco.total == null) {
      return { score: 'N/A', band: 'band-mid', label: 'No eco data', icon: '?' };
    }
    return {
      score: String(result.eco.total),
      band: scoreBand(result.eco.total),
      label: 'Eco',
      icon: '🌿',
    };
  }
  return { score: '?', band: 'loading', label: 'Limited data', icon: '?' };
}

let badgeEl = null;
/** @type {{ result: object | null, payload: object | null }} */
let lastAnalysis = { result: null, payload: null };

function ensureBadge() {
  if (badgeEl && document.body.contains(badgeEl)) return badgeEl;

  const title = findTitleElement({ title: ['#productTitle', '#title', 'h1.a-size-large'] });
  if (!title) return null;

  badgeEl = document.createElement('div');
  badgeEl.id = 'ecohealth-badge';
  badgeEl.setAttribute('role', 'button');
  badgeEl.setAttribute('aria-label', 'Open EcoHealth analysis');
  badgeEl.innerHTML = `
    <span class="ecohealth-score-circle loading" data-score>…</span>
    <span class="ecohealth-label">Analyzing…</span>
  `;

  badgeEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Port connect runs in the same user-gesture turn as the click (reliable panel open).
    try {
      chrome.runtime.connect({ name: 'ecohealth-open-panel' });
    } catch (err) {
      console.warn('[EcoHealth] panel connect', err);
    }

    chrome.runtime.sendMessage(
      {
        type: 'OPEN_PANEL',
        asin: lastAnalysis.payload?.asin,
        result: lastAnalysis.result,
        payload: lastAnalysis.payload,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[EcoHealth] open panel:', chrome.runtime.lastError.message);
          return;
        }
        if (response && !response.ok) {
          console.warn('[EcoHealth] open panel failed:', response.error);
        }
      }
    );
  });

  if (title.parentElement) {
    title.parentElement.insertBefore(badgeEl, title.nextSibling);
  }
  return badgeEl;
}

function updateBadge(result, phase = 'done') {
  const badge = ensureBadge();
  if (!badge) return;

  const { score, band, label, icon } = displayScore(result, phase);
  const circle = badge.querySelector('.ecohealth-score-circle');
  const labelEl = badge.querySelector('.ecohealth-label');
  if (circle) {
    circle.textContent = score;
    circle.className = `ecohealth-score-circle ${band}`;
  }
  if (labelEl) labelEl.textContent = `${icon} ${label}`;
}

function setBadgeLoading() {
  updateBadge(null, 'loading');
}

// --- content-script.js ---
let selectorRegistry = null;

async function loadSelectors() {
  if (selectorRegistry) return selectorRegistry;
  const url = chrome.runtime.getURL('content/selectors/amazon-in.json');
  const res = await fetch(url);
  selectorRegistry = await res.json();
  return selectorRegistry;
}

function requestAnalysis(payload, forceRefresh = false) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'ANALYZE_PRODUCT', payload, forceRefresh },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[EcoHealth]', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        if (!response?.ok) {
          console.warn('[EcoHealth]', response?.error);
          resolve(null);
          return;
        }
        resolve(response?.result ?? null);
      }
    );
  });
}

function stripImagesForQuickAnalyze(payload) {
  return {
    ...payload,
    productImages: undefined,
    productImageBuffers: undefined,
    productImageClarity: undefined,
    skipImageOcr: true,
    autoNutritionOcr: false,
  };
}

function isGoodEnoughResult(result) {
  if (!result) return false;
  if (result.enrichment?.offMatched) return true;
  if (result.enrichment?.nutritionSource === 'label_ocr') return true;
  if (result.enrichment?.nutritionSource === 'page' && result.confidence !== 'low') return true;
  if (
    result.health?.total != null &&
    result.enrichment?.nutritionSource !== 'ingredient_estimate'
  ) {
    return true;
  }
  return false;
}

async function requestAnalysisWithRetry(payload, forceRefresh = false) {
  let result = await requestAnalysis(payload, forceRefresh);
  if (!result) {
    await new Promise((r) => setTimeout(r, 2500));
    result = await requestAnalysis(payload, true);
  }
  return result;
}

async function run() {
  setBadgeLoading();
  chrome.runtime.sendMessage({ type: 'WAKE_BACKEND' }).catch(() => {});
  const initialBadge = ensureBadge();
  if (!initialBadge) {
    // Some Amazon layouts render title late; retry briefly before giving up.
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      const badge = ensureBadge();
      if (badge || attempts >= 40) clearInterval(timer);
    }, 250);
  }

  const selectors = await loadSelectors();
  const payload = buildPayload(selectors);
  if (!payload) {
    console.warn('[EcoHealth] Could not extract ASIN');
    return;
  }

  console.info('[EcoHealth] images sent:', payload.productImages?.length ?? 0);
  const fetchOcrImages = shouldFetchImagesForOcr(payload);
  if (!fetchOcrImages) {
    console.info('[EcoHealth] skipping gallery OCR for non-food listing');
  }
  const richPageData =
    payload.rawHints?.hasNutrition &&
    payload.rawHints?.hasIngredients &&
    payload.nutrition &&
    Object.keys(payload.nutrition).filter((k) => k !== 'per' && payload.nutrition[k] != null).length >= 4;
  if (richPageData) {
    console.info('[EcoHealth] page already has nutrition + ingredients — skipping gallery OCR');
  }
  // Phase 1: page text + Amazon barcode → Open Food Facts (no image upload).
  let result = await requestAnalysisWithRetry(stripImagesForQuickAnalyze(payload));
  if (result?.enrichment?.offMatched) {
    console.info('[EcoHealth] OFF hit (page barcode):', result.enrichment.barcode);
  }

  const needsImagePass =
    fetchOcrImages && !richPageData && !isGoodEnoughResult(result);

  if (needsImagePass) {
    payload.autoNutritionOcr = true;
    payload.skipImageOcr = false;
    payload.productImageBuffers = await fetchImagesForOcr(
      payload.productImages || [],
      payload.selectedImageUrl,
      { autoNutrition: true }
    );
    payload.productImageClarity = (payload.productImageBuffers || []).map((b) => ({
      imageId: amazonImageId(b.url),
      url: b.url,
      ...b.clarity,
    }));
    console.info('[EcoHealth] OCR buffers loaded:', payload.productImageBuffers?.length ?? 0);
    if (payload.productImageBuffers?.length) {
      console.info(
        '[EcoHealth] OCR image ids:',
        payload.productImageBuffers.map((b) => amazonImageId(b.url)).filter(Boolean).join(', ')
      );
    }
    result = await requestAnalysisWithRetry(payload, true);
    if (result?.enrichment?.offMatched) {
      console.info('[EcoHealth] OFF hit (pack barcode):', result.enrichment.barcode);
    }
  }

  lastAnalysis = { result, payload };
  updateBadge(result, result ? 'done' : 'failed');
  if (result?.enrichment) {
    console.info(
      '[EcoHealth] nutrition:',
      result.enrichment.nutritionSource,
      result.enrichment.parsedNutrition || ''
    );
    if (result.enrichment.bestNutritionImageId) {
      console.info('[EcoHealth] best label image:', result.enrichment.bestNutritionImageId);
    }
  }
  if (result?.variants?.length) {
    console.info('[EcoHealth] variants:', result.variants.map((v) => `${v.name}=${v.health?.total}`).join(', '));
  }

  startLandingImageWatcher(selectors);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'ANALYSIS_UPDATED' && msg.asin === payload.asin) {
      updateBadge(msg.result);
    }
  });
}

let landingWatcherStarted = false;

/**
 * Re-analyze when user selects another gallery image (e.g. nutrition table slide).
 * @param {object} selectors
 */
function startLandingImageWatcher(selectors) {
  if (landingWatcherStarted) return;
  const landing = document.querySelector('#landingImage, #imgBlkFront');
  if (!landing) return;
  landingWatcherStarted = true;

  let lastImageId = '';
  let debounceTimer = null;
  /** @type {string | null} */
  let pendingThumbUrl = null;

  const scheduleReanalyze = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const url = pendingThumbUrl || getActiveGalleryImageUrl();
      pendingThumbUrl = null;
      const id = amazonImageId(url) || '';
      if (!url || !id || id === lastImageId) return;
      if (!/_SL1[0-9]{3}|_AC_SL1[0-9]{3}/i.test(url)) return;

      lastImageId = id;
      console.info('[EcoHealth] gallery image selected — re-analyzing:', id);

      const freshPayload = buildPayload(selectors);
      if (!freshPayload) return;

      freshPayload.selectedImageUrl = url;

      if (freshPayload.productImages?.length || url) {
        freshPayload.productImageBuffers = await fetchImagesForOcr(
          freshPayload.productImages || [],
          url,
          { selectedOnly: true }
        );
        freshPayload.productImageClarity = (freshPayload.productImageBuffers || []).map(
          (b) => ({
            imageId: amazonImageId(b.url),
            url: b.url,
            ...b.clarity,
          })
        );
        freshPayload.ocrSelectedOnly = true;
        console.info('[EcoHealth] OCR selected image only:', id);
      }

      const result = await requestAnalysis(freshPayload, true);
      if (result) {
        lastAnalysis = { result, payload: freshPayload };
        updateBadge(result);
        if (
          freshPayload.ocrSelectedOnly &&
          result.enrichment?.labelTableDetected === false
        ) {
          console.warn(
            '[EcoHealth] No nutrition table on image',
            id,
            '— select the nutrition facts thumbnail (not the front pack).'
          );
        }
        if (result.enrichment) {
          console.info(
            '[EcoHealth] nutrition (re-analyze):',
            result.enrichment.nutritionSource,
            result.enrichment.parsedNutrition || ''
          );
          if (result.enrichment.bestNutritionImageId) {
            console.info('[EcoHealth] best label image:', result.enrichment.bestNutritionImageId);
          }
        }
      }
    }, 1200);
  };

  const observer = new MutationObserver(scheduleReanalyze);
  observer.observe(landing, {
    attributes: true,
    attributeFilter: ['src', 'data-old-hires', 'data-a-dynamic-image'],
  });

  document
    .querySelectorAll('#altImages li, .imageThumbnail, #ivThumbs .imageThumb')
    .forEach((el) => {
      el.addEventListener('click', (ev) => {
        const thumbImg =
          ev.target?.tagName === 'IMG'
            ? ev.target
            : el.querySelector('img');
        if (thumbImg) {
          pendingThumbUrl = resolveAmazonImageUrl(thumbImg) || null;
        }
        setTimeout(scheduleReanalyze, 500);
      });
    });
}

function startSpaObserver() {
  if (!document.body) return;
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(run, 800);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function boot() {
  if (!isProductPage()) {
    console.info('[EcoHealth] skipped — not a product page:', location.pathname);
    return;
  }
  console.info('[EcoHealth] analyzing product page');
  run();
  startSpaObserver();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
