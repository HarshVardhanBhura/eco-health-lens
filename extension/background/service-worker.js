/**
 * MV3 service worker — cache, API, side panel (tab-scoped).
 */

import { API_BASE_URL } from '../shared/config.js';

const CACHE_PREFIX = 'analysis:v34:';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** @type {number | null} Tab that owns the open side panel */
let panelTabId = null;
/** @type {number | null} Window where the panel was opened */
let panelWindowId = null;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[EcoHealth] Extension installed');
  chrome.sidePanel
    .setOptions({ path: 'sidepanel/panel.html', enabled: true })
    .catch(() => {});
  clearAnalysisCache().catch(() => {});
});

if (chrome.sidePanel?.onClosed) {
  chrome.sidePanel.onClosed.addListener(() => {
    panelTabId = null;
    panelWindowId = null;
  });
}

/**
 * @param {number} tabId
 */
async function setPanelForTab(tabId) {
  await chrome.sidePanel.setOptions({
    path: 'sidepanel/panel.html',
    enabled: true,
  });
  await chrome.sidePanel.setOptions({
    tabId,
    path: 'sidepanel/panel.html',
    enabled: true,
  });
}

/**
 * Close the side panel when the user leaves the product tab.
 * @param {number | null} tabId
 * @param {number | null} windowId
 */
async function closeSidePanel(tabId, windowId) {
  if (chrome.sidePanel?.close) {
    if (tabId != null) {
      try {
        await chrome.sidePanel.close({ tabId });
        return;
      } catch {
        /* fall through */
      }
    }
    if (windowId != null) {
      try {
        await chrome.sidePanel.close({ windowId });
        return;
      } catch {
        /* fall through */
      }
    }
  }

  if (tabId != null) {
    try {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
    } catch {
      /* ignore */
    }
  }
  try {
    await chrome.sidePanel.setOptions({ enabled: false });
  } catch {
    /* ignore */
  }

  chrome.runtime.sendMessage({ type: 'PANEL_CLOSE' }).catch(() => {});
}

/**
 * @param {number} tabId
 */
async function rememberPanelContext(tabId) {
  panelTabId = tabId;
  try {
    const tab = await chrome.tabs.get(tabId);
    panelWindowId = tab.windowId ?? null;
  } catch {
    panelWindowId = null;
  }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (panelTabId == null) return;
  if (activeInfo.tabId === panelTabId) return;

  const prevTabId = panelTabId;
  const prevWindowId = panelWindowId;
  panelTabId = null;
  panelWindowId = null;
  await closeSidePanel(prevTabId, prevWindowId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== panelTabId) return;
  const prevWindowId = panelWindowId;
  panelTabId = null;
  panelWindowId = null;
  closeSidePanel(tabId, prevWindowId).catch(() => {});
});

/** Preserve user-gesture when opening from content-script click via port.connect */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ecohealth-open-panel') return;
  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;
  rememberPanelContext(tabId).then(() => {
    openSidePanelNow(tabId);
    setPanelForTab(tabId).catch((e) => console.warn('[EcoHealth] panel options', e));
  });
});

/**
 * @param {string} asin
 * @returns {Promise<import('../shared/types.js').AnalysisResult | null>}
 */
async function getCached(asin) {
  const key = `${CACHE_PREFIX}${asin}`;
  const data = await chrome.storage.local.get(key);
  const entry = data[key];
  if (!entry || Date.now() - entry.ts > CACHE_TTL_MS) return null;
  return entry.result;
}

/**
 * @param {string} asin
 * @param {import('../shared/types.js').AnalysisResult} result
 */
async function setCached(asin, result) {
  const key = `${CACHE_PREFIX}${asin}`;
  await chrome.storage.local.set({ [key]: { ts: Date.now(), result } });
}

/**
 * @param {number} tabId
 * @param {object} data
 */
async function setTabAnalysis(tabId, data) {
  const key = `tabAnalysis:${tabId}`;
  await chrome.storage.session.set({ [key]: data, panelTabId: tabId });
}

/**
 * @param {number} tabId
 */
async function getTabAnalysis(tabId) {
  const key = `tabAnalysis:${tabId}`;
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

/**
 * @param {import('../shared/types.js').ProductPayload} payload
 * @returns {Promise<import('../shared/types.js').AnalysisResult>}
 */
async function wakeBackend() {
  try {
    await fetch(`${API_BASE_URL}/v1/health`, { signal: AbortSignal.timeout(90_000) });
  } catch (e) {
    console.warn('[EcoHealth] backend wake', e?.message || e);
  }
}

async function fetchAnalysis(payload) {
  await wakeBackend();
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${API_BASE_URL}/v1/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(55_000),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || `API ${res.status}`);
      }
      return res.json();
    } catch (e) {
      lastErr = e;
      if (attempt === 0) {
        console.warn('[EcoHealth] analyze retry after', e?.message || e);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
    }
  }
  throw lastErr;
}

/**
 * @param {import('../shared/types.js').ProductPayload} payload
 * @param {number | undefined} tabId
 */
async function analyzeProduct(payload, tabId, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await getCached(payload.asin);
    if (cached) {
      if (tabId != null) {
        await setTabAnalysis(tabId, { asin: payload.asin, result: cached, payload });
      }
      return cached;
    }
  }

  const result = await fetchAnalysis(payload);
  result.asin = payload.asin;
  result.title = result.title || payload.title;
  const cacheable =
    result.enrichment?.nutritionSource === 'label_ocr' ||
    result.enrichment?.nutritionSource === 'open_food_facts' ||
    result.enrichment?.nutritionSource === 'pack_label_partial' ||
    (result.confidence && result.confidence !== 'low' && result.enrichment?.nutritionSource !== 'ingredient_estimate');
  if (cacheable) await setCached(payload.asin, result);

  if (tabId != null) {
    await setTabAnalysis(tabId, { asin: payload.asin, result, payload });
  }

  return result;
}

async function clearAnalysisCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length) {
    await chrome.storage.local.remove(keys);
  }
  await chrome.storage.session.clear();
}

/**
 * @param {number} tabId
 */
function openSidePanelNow(tabId) {
  try {
    chrome.sidePanel.open({ tabId });
  } catch (e) {
    console.error('[EcoHealth] sidePanel.open failed', e);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'WAKE_BACKEND') {
    wakeBackend().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'ANALYZE_PRODUCT') {
    const tabId = sender.tab?.id;
    analyzeProduct(message.payload, tabId, Boolean(message.forceRefresh))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => {
        console.error('[EcoHealth] analyze failed', err);
        sendResponse({ ok: false, error: String(err.message || err) });
      });
    return true;
  }

  if (message.type === 'OPEN_PANEL') {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: 'No tab id' });
      return false;
    }

    rememberPanelContext(tabId);
    openSidePanelNow(tabId);

    (async () => {
      try {
        if (message.result && message.asin) {
          await setTabAnalysis(tabId, {
            asin: message.asin,
            result: message.result,
            payload: message.payload,
          });
        }
        await setPanelForTab(tabId);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[EcoHealth] OPEN_PANEL setup failed', e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'PANEL_CLAIM_TAB' && message.tabId != null) {
    rememberPanelContext(message.tabId);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'PANEL_NO_DATA') {
    (async () => {
      await closeSidePanel(panelTabId, panelWindowId);
      panelTabId = null;
      panelWindowId = null;
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'GET_LAST_ANALYSIS') {
    const tabId = message.tabId;
    (async () => {
      if (tabId == null) {
        sendResponse({ ok: true, result: null });
        return;
      }
      const data = await getTabAnalysis(tabId);
      sendResponse({ ok: true, ...data });
    })();
    return true;
  }

  return false;
});
