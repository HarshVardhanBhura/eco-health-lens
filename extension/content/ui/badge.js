/**
 * Injects score badge near #productTitle; click opens side panel.
 */

/** @param {number | null} score */
function scoreBand(score) {
  if (score == null || Number.isNaN(score)) return 'loading';
  if (score < 40) return 'band-low';
  if (score < 70) return 'band-mid';
  return 'band-high';
}

/** @param {import('../../shared/types.js').AnalysisResult | null} result */
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

function ensureBadge() {
  if (badgeEl && document.body.contains(badgeEl)) return badgeEl;

  const title = document.querySelector('#productTitle');
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
    chrome.runtime.sendMessage({ type: 'OPEN_PANEL' });
  });

  if (title.parentElement) {
    title.parentElement.insertBefore(badgeEl, title.nextSibling);
  }
  return badgeEl;
}

/** @param {import('../../shared/types.js').AnalysisResult | null} result */
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
