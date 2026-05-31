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

function extractNutrition(selectors) {
  let blob = '';
  const keywords = selectors.nutritionKeywords || ['nutrition'];
  document.querySelectorAll('table').forEach((table) => {
    const t = (table.textContent || '').toLowerCase();
    if (keywords.some((k) => t.includes(k.toLowerCase()))) {
      blob += '\n' + table.textContent;
    }
  });
  document.querySelectorAll('#important-information, #productDetails_feature_div').forEach((el) => {
    const t = (el.textContent || '').toLowerCase();
    if (keywords.some((k) => t.includes(k.toLowerCase()))) {
      blob += '\n' + el.textContent;
    }
  });
  const parsed = parseNutritionTable(blob);
  return Object.keys(parsed).length > 1 ? parsed : null;
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

const MAX_OCR_FETCH = 8;
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
 * Fetch gallery images in-browser (Amazon often blocks server-side image fetch).
 * @param {Array<{ url: string, alt?: string }>} images
 */
/**
 * @param {Array<{ url: string, alt?: string, priority?: number }>} images
 * @param {string} [landingImageUrl]
 */
async function fetchImagesForOcr(images, landingImageUrl) {
  /** @type {Array<{ url: string, alt: string, priority: number }>} */
  const queue = [];

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

  for (const img of ranked.slice(0, MAX_OCR_FETCH)) {
    if (buffers.length >= 6) break;
    try {
      const res = await fetch(img.url, { credentials: 'same-origin', mode: 'cors' });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.size < 400 || blob.size > MAX_OCR_BYTES) continue;
      const type = blob.type || 'image/jpeg';
      if (/webp/i.test(type) || /\.webp(\?|$)/i.test(img.url || '')) continue;
      if (!/^image\/(jpeg|jpg|png|gif)/i.test(type)) continue;
      const { base64, mimeType } = await blobToBase64(blob);
      buffers.push({
        base64,
        mimeType,
        alt: img.alt || '',
        url: img.url,
      });
    } catch (e) {
      console.warn('[EcoHealth] gallery image fetch failed', img.url?.slice(0, 80), e);
    }
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
  const barcode = extractBarcode(selectorRegistry);
  const materialsText = extractMaterials(selectorRegistry);
  const packWeightG = extractPackWeight(selectorRegistry);
  const productImages = extractProductImages();
  const landing = document.querySelector('#landingImage, #imgBlkFront');
  const selectedImageUrl = landing ? resolveAmazonImageUrl(landing) : undefined;
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

function displayScore(result) {
  if (!result) return { score: '?', band: 'loading', label: 'Analyzing…', icon: '…' };
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
      return { score: 'N/A', band: 'loading', label: 'No eco data', icon: '?' };
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

function updateBadge(result) {
  const badge = ensureBadge();
  if (!badge) return;

  const { score, band, label, icon } = displayScore(result);
  const circle = badge.querySelector('.ecohealth-score-circle');
  const labelEl = badge.querySelector('.ecohealth-label');
  if (circle) {
    circle.textContent = score;
    circle.className = `ecohealth-score-circle ${band}`;
  }
  if (labelEl) labelEl.textContent = `${icon} ${label}`;
}

function setBadgeLoading() {
  updateBadge(null);
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

async function run() {
  setBadgeLoading();
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
  if (payload.productImages?.length || payload.selectedImageUrl) {
    payload.productImageBuffers = await fetchImagesForOcr(
      payload.productImages || [],
      payload.selectedImageUrl
    );
    console.info('[EcoHealth] OCR buffers loaded:', payload.productImageBuffers?.length ?? 0);
    if (payload.selectedImageUrl) {
      console.info(
        '[EcoHealth] landing image for OCR:',
        toFullResAmazonImageUrl(payload.selectedImageUrl).slice(-60)
      );
    }
  }
  const result = await requestAnalysis(payload);
  lastAnalysis = { result, payload };
  updateBadge(result);
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

  const scheduleReanalyze = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const url = resolveAmazonImageUrl(landing);
      const id = amazonImageId(url) || '';
      if (!url || !id || id === lastImageId) return;
      if (!/_SL1[0-9]{3}|_AC_SL1[0-9]{3}/i.test(url)) return;

      lastImageId = id;
      console.info('[EcoHealth] gallery image selected — re-analyzing:', id);

      const freshPayload = buildPayload(selectors);
      if (!freshPayload) return;

      if (freshPayload.productImages?.length || freshPayload.selectedImageUrl) {
        freshPayload.productImageBuffers = await fetchImagesForOcr(
          freshPayload.productImages || [],
          freshPayload.selectedImageUrl
        );
      }

      const result = await requestAnalysis(freshPayload, true);
      if (result) {
        lastAnalysis = { result, payload: freshPayload };
        updateBadge(result);
      }
    }, 1200);
  };

  const observer = new MutationObserver(scheduleReanalyze);
  observer.observe(landing, {
    attributes: true,
    attributeFilter: ['src', 'data-old-hires', 'data-a-dynamic-image'],
  });

  document.querySelectorAll('#altImages li, .imageThumbnail, #ivThumbs .imageThumb').forEach((el) => {
    el.addEventListener('click', () => setTimeout(scheduleReanalyze, 300));
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
