/**
 * Side panel — renders AnalysisResult from session storage.
 */

/** @param {string} id */
function $(id) {
  return document.getElementById(id);
}

function hideAllSections() {
  $('loading')?.classList.add('hidden');
  $('error')?.classList.add('hidden');
  $('health-section')?.classList.add('hidden');
  $('eco-section')?.classList.add('hidden');
  $('ingredients-section')?.classList.add('hidden');
  $('variants-toggle')?.classList.add('hidden');
  $('variants-section')?.classList.add('hidden');
}

/**
 * @param {HTMLElement} listEl
 * @param {Array<{ text: string, type?: string }>} items
 */
function renderRationaleList(listEl, items) {
  if (!listEl) return;
  listEl.innerHTML = '';
  for (const r of items || []) {
    const li = document.createElement('li');
    li.textContent = r.text;
    li.className = r.type || 'neutral';
    listEl.appendChild(li);
  }
}

/**
 * @param {string} toggleId
 * @param {string} panelId
 */
function wireBreakdownToggle(toggleId, panelId) {
  const toggle = $(toggleId);
  const panel = $(panelId);
  if (!toggle || !panel) return;

  toggle.onclick = () => {
    const hidden = panel.classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', String(!hidden));
    panel.setAttribute('aria-hidden', String(hidden));
    toggle.textContent = hidden ? 'Full breakdown' : 'Hide breakdown';
  };
}

/**
 * @param {import('../shared/types.js').HealthResult} health
 */
function renderHealthBreakdown(health) {
  const macroEl = $('macro-bars');
  const sub = $('health-components');
  if (!macroEl || !sub) return;

  const macros = health.components?.macros?.items || [];
  macroEl.innerHTML = '';
  const highlightItems = macros.filter((m) => m.status === 'bad' || m.status === 'warn' || m.status === 'good');
  const toShow = highlightItems.length ? highlightItems : macros.slice(0, 4);

  for (const m of toShow) {
    const pct = Math.min(100, m.refPercent ?? 0);
    const row = document.createElement('div');
    row.className = 'macro-row';
    row.innerHTML = `
      <div class="macro-name">
        <span>${m.name}</span>
        <span>${m.value != null ? `${m.value}${m.unit || 'g'}` : m.value_g != null ? `${m.value_g}g` : ''} ${pct ? `(${pct}% DV)` : ''}</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill ${m.status || 'neutral'}" style="width:${pct}%"></div>
      </div>
    `;
    macroEl.appendChild(row);
  }

  sub.innerHTML = '';
  const comp = health.components || {};
  const rows = [
    ['Macros', comp.macros?.score],
    ['Additives', comp.additives?.score],
    ['Processing', comp.processing?.score],
    ['Nutri-Score', comp.nutriscore?.score],
  ];
  for (const [label, score] of rows) {
    if (score == null) continue;
    const div = document.createElement('div');
    div.className = 'sub-row';
    div.innerHTML = `<span>${label}</span><span>${score}</span>`;
    sub.appendChild(div);
  }
}

/**
 * @param {Array<import('../shared/types.js').VariantResult>} variants
 */
function renderVariants(variants) {
  const section = $('variants-section');
  const toggle = $('variants-toggle');
  if (!section || !toggle || !variants?.length) return;

  toggle.classList.remove('hidden');
  section.innerHTML = '';
  section.classList.add('hidden');
  section.setAttribute('aria-hidden', 'true');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = `Compare all ${variants.length} variants`;

  const flipVariants = () => {
    const open = section.classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', String(!open));
    section.setAttribute('aria-hidden', String(open));
    toggle.textContent = open
      ? `Compare all ${variants.length} variants`
      : 'Hide variant breakdown';
  };
  toggle.onclick = flipVariants;
  section._flipVariants = flipVariants;

  for (const v of variants) {
    const card = document.createElement('article');
    card.className = 'variant-card';
    const h = v.health || {};
    const src =
      v.dataSource === 'label'
        ? 'From pack label'
        : v.dataSource === 'ingredients_est'
          ? 'Estimated from ingredients'
          : '';
    const summary = v.summaryLine || h.rationale?.[0]?.text || '';

    card.innerHTML = `
      <header class="variant-card-header">
        <div class="variant-title-block">
          <h3>${v.name}</h3>
          <p class="variant-summary">${summary}</p>
        </div>
        <div class="variant-scores">
          <span class="variant-score">${h.total ?? '—'}</span>
          <span class="variant-grade">${h.grade ? `Grade ${h.grade}` : ''}${src ? ` · ${src}` : ''}</span>
        </div>
      </header>
      <div class="variant-details hidden"></div>
    `;

    const details = card.querySelector('.variant-details');
    let detailHtml = '';
    if (h.rationale?.length) {
      detailHtml += '<p class="variant-detail-title">Why this score</p><ul class="variant-rationale">';
      for (const r of h.rationale) {
        detailHtml += `<li class="${r.type || 'neutral'}">${r.text}</li>`;
      }
      detailHtml += '</ul>';
    }
    const flagged = (v.ingredients || []).filter((i) => i.sentiment === 'bad');
    if (flagged.length) {
      detailHtml += '<p class="variant-detail-title">Flagged ingredients</p><ul class="variant-ing-list">';
      for (const ing of flagged.slice(0, 5)) {
        detailHtml += `<li class="ingredient-bad">${ing.text}</li>`;
      }
      detailHtml += '</ul>';
    }
    details.innerHTML = detailHtml || '<p class="variant-detail-title">No extra detail</p>';

    card.querySelector('.variant-card-header').addEventListener('click', () => {
      details.classList.toggle('hidden');
    });
    section.appendChild(card);
  }
}

/**
 * @param {import('../shared/types.js').IngredientItem[]} ingredients
 */
function renderFlaggedIngredients(ingredients) {
  const section = $('ingredients-section');
  const ul = $('ingredients-list');
  const expandBtn = $('ingredients-expand');
  const heading = $('ingredients-heading');
  if (!section || !ul) return;

  const flagged = ingredients.filter((i) => i.sentiment === 'bad');
  const neutralGood = ingredients.filter((i) => i.sentiment !== 'bad');

  if (!ingredients.length) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  ul.innerHTML = '';
  let showingAll = false;

  const paint = (list) => {
    ul.innerHTML = '';
    for (const ing of list) {
      const li = document.createElement('li');
      const cls =
        ing.sentiment === 'good'
          ? 'ingredient-good'
          : ing.sentiment === 'bad'
            ? 'ingredient-bad'
            : 'ingredient-neutral';
      li.className = cls;
      li.innerHTML = `<span>${ing.text}</span>${ing.reason ? `<span class="reason">${ing.reason}</span>` : ''}`;
      ul.appendChild(li);
    }
  };

  if (flagged.length) {
    heading.textContent = 'Flagged ingredients';
    paint(flagged);
    if (neutralGood.length && expandBtn) {
      expandBtn.classList.remove('hidden');
      expandBtn.textContent = 'Show all ingredients';
      expandBtn.setAttribute('aria-expanded', 'false');
      expandBtn.onclick = () => {
        showingAll = !showingAll;
        expandBtn.setAttribute('aria-expanded', String(showingAll));
        if (showingAll) {
          paint(ingredients);
          expandBtn.textContent = 'Show flagged only';
        } else {
          paint(flagged);
          expandBtn.textContent = 'Show all ingredients';
        }
      };
    } else {
      expandBtn?.classList.add('hidden');
    }
  } else {
    heading.textContent = 'Ingredients';
    paint(ingredients.slice(0, 8));
    if (ingredients.length > 8 && expandBtn) {
      expandBtn.classList.remove('hidden');
      expandBtn.onclick = () => {
        showingAll = !showingAll;
        expandBtn.setAttribute('aria-expanded', String(showingAll));
        paint(showingAll ? ingredients : ingredients.slice(0, 8));
        expandBtn.textContent = showingAll ? 'Show fewer' : 'Show all ingredients';
      };
    } else {
      expandBtn?.classList.add('hidden');
    }
  }
}

/** @param {import('../shared/types.js').AnalysisResult} result */
function render(result) {
  hideAllSections();

  $('product-title').textContent = result.title || 'Product analysis';
  const conf = $('confidence');
  conf.textContent = `Data confidence: ${result.confidence}`;
  conf.className = `confidence ${result.confidence}`;

  const low = $('low-confidence');
  if (result.message || result.confidence === 'low') {
    low.classList.remove('hidden');
    low.textContent =
      result.message ||
      'Limited data available — scores may be incomplete.';
  } else {
    low.classList.add('hidden');
  }

  $('disclaimer').textContent =
    result.disclaimer ||
    'Informational only — not medical or environmental certification.';
  $('sources').textContent = result.sources?.length
    ? `Sources: ${result.sources.join(', ')}`
    : '';

  if (result.health) {
    $('health-section').classList.remove('hidden');
    $('health-total').textContent = String(result.health.total);

    const labelEl = $('health-score-label');
    const hintEl = $('health-variant-hint');
    const hasVariants = result.variants?.length >= 2;
    if (hasVariants) {
      if (labelEl) labelEl.textContent = 'Average health score';
      if (hintEl) {
        hintEl.classList.remove('hidden');
        hintEl.textContent = `Avg. of ${result.variants.length} variants — compare below`;
      }
      renderVariants(result.variants);
      const scoreHeader = document.querySelector('#health-section .score-header');
      if (scoreHeader) {
        scoreHeader.style.cursor = 'pointer';
        scoreHeader.title = 'Click to compare variants';
        scoreHeader.onclick = () => {
          const section = $('variants-section');
          if (section?._flipVariants) section._flipVariants();
        };
      }
    } else {
      if (labelEl) labelEl.textContent = 'Health score';
      hintEl?.classList.add('hidden');
      $('variants-toggle')?.classList.add('hidden');
      $('variants-section')?.classList.add('hidden');
    }

    const grade = $('health-grade');
    if (result.health.grade) {
      grade.textContent = hasVariants
        ? `Avg grade ${result.health.grade}`
        : `Grade ${result.health.grade}`;
      grade.classList.remove('hidden');
    } else {
      grade.textContent = '';
    }

    renderRationaleList($('health-rationale'), result.health.rationale);
    renderHealthBreakdown(result.health);

    const breakdown = $('health-breakdown');
    const breakdownToggle = $('health-breakdown-toggle');
    if (breakdown) {
      breakdown.classList.add('hidden');
      breakdown.setAttribute('aria-hidden', 'true');
    }
    if (breakdownToggle) {
      breakdownToggle.setAttribute('aria-expanded', 'false');
      breakdownToggle.textContent = 'Full breakdown';
      wireBreakdownToggle('health-breakdown-toggle', 'health-breakdown');
    }
  }

  if (result.eco) {
    $('eco-section').classList.remove('hidden');
    const noEcoScore = result.eco.insufficientData || result.eco.total == null;
    $('eco-total').textContent = noEcoScore ? 'N/A' : String(result.eco.total);
    $('eco-total').classList.toggle('eco-na', noEcoScore);
    const eg = $('eco-grade');
    eg.textContent = noEcoScore ? 'No score' : result.eco.grade ? `Grade ${result.eco.grade}` : '';

    renderRationaleList($('eco-rationale'), result.eco.rationale);
  }

  if (result.ingredients?.length && !result.variants?.length) {
    renderFlaggedIngredients(result.ingredients);
  } else {
    $('ingredients-section')?.classList.add('hidden');
  }
}

function showError(msg) {
  hideAllSections();
  const err = $('error');
  err.classList.remove('hidden');
  err.textContent = msg;
}

function loadForTab(tabId) {
  chrome.runtime.sendMessage({ type: 'GET_LAST_ANALYSIS', tabId }, (response) => {
    if (chrome.runtime.lastError) {
      showError('Could not load analysis. Open an Amazon India product page first.');
      return;
    }
    if (!response?.result) {
      $('loading').classList.remove('hidden');
      $('loading').textContent =
        'No analysis on this tab. Open an Amazon India product page and wait for the badge.';
      chrome.runtime.sendMessage({ type: 'PANEL_NO_DATA' }).catch(() => {});
      return;
    }
    chrome.runtime.sendMessage({ type: 'PANEL_CLAIM_TAB', tabId }).catch(() => {});
    render(response.result);
  });
}

async function load() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId == null) {
    showError('No active tab.');
    return;
  }
  loadForTab(tabId);
}

load();

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PANEL_CLOSE') {
    window.close();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (tabId == null) return;
    const key = `tabAnalysis:${tabId}`;
    if (changes[key]?.newValue?.result) {
      render(changes[key].newValue.result);
    }
  });
});
