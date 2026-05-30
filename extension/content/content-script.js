/**
 * Amazon IN content script entry — extract, analyze, badge.
 * Loaded after amazon-in.js and badge.js (shared content-script scope).
 */

/** @type {Record<string, string[]> | null} */
let selectorRegistry = null;

async function loadSelectors() {
  if (selectorRegistry) return selectorRegistry;
  const url = chrome.runtime.getURL('content/selectors/amazon-in.json');
  const res = await fetch(url);
  selectorRegistry = await res.json();
  return selectorRegistry;
}

/** @param {import('../shared/types.js').ProductPayload} payload */
function requestAnalysis(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'ANALYZE_PRODUCT', payload },
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
  ensureBadge();

  const selectors = await loadSelectors();
  const payload = buildPayload(selectors);
  if (!payload) {
    console.warn('[EcoHealth] Could not extract ASIN');
    return;
  }

  const result = await requestAnalysis(payload);
  updateBadge(result);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'ANALYSIS_UPDATED' && msg.asin === payload.asin) {
      updateBadge(msg.result);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => run());
} else {
  run();
}

// SPA-style navigation on Amazon
let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(run, 800);
  }
});
observer.observe(document.body, { childList: true, subtree: true });
