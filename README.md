# EcoHealth Lens — Chrome Extension MVP

Amazon India product pages get an **eco score** (non-food) or **health score** with macros and red/green ingredient flags (food). A badge on the page and a Chrome side panel show results enriched by a local backend and [Open Food Facts](https://world.openfoodfacts.org/).

## File tree

```
extension/                         # Load this folder in Chrome (MV3)
├── manifest.json
├── background/service-worker.js
├── content/
│   ├── content-script.js
│   ├── extractors/amazon-in.js
│   ├── selectors/amazon-in.json
│   └── ui/badge.js, badge.css
├── sidepanel/panel.html, panel.css, panel.js
├── shared/config.js, types.js
└── icons/

backend/
├── server.js                      # Node HTTP server (no npm required)
├── routes/analyze.js
├── services/cache.js, merge.js, openFoodFacts.js
├── scoring/health.js, eco.js, ingredients.js, detectProductType.js
├── data/additives.json, cache.json (created at runtime)
└── scripts/health-check.js, generate-icons.js
```

## Quick start

### 1. Backend (Node 18+)

Uses only Node built-ins — no `npm install` required.

```powershell
cd backend
node server.js
```

API: **http://localhost:3000**

Health check:

```powershell
node scripts/health-check.js
```

Optional: `npm install` only if you switch to the Fastify variant in `package.json`.

### 2. Extension icons (once)

```powershell
node scripts/generate-icons.js
```

Icons are written to `extension/icons/`.

### 3. Chrome

1. `chrome://extensions` → **Developer mode**
2. **Load unpacked** → select the `extension` folder
3. Open an Amazon India product: `https://www.amazon.in/dp/ASIN`

Wait ~1–2s for the badge; click it to open the **side panel**.

API URL: edit `extension/shared/config.js` (`API_BASE_URL`) and `manifest.json` `host_permissions` for non-localhost deploys.

## Manual test matrix (Amazon India)

| # | Scenario | Expected badge | Expected panel |
|---|----------|----------------|----------------|
| 1 | Food, full nutrition + ingredients | Health score, apple icon | Macro bars, colored ingredients, sub-scores |
| 2 | Food, ingredients only (no nutrition table) | Score, medium/low confidence | Warning about partial data |
| 3 | Food, OFF barcode hit | Score; sources include `open_food_facts` | Nutri-Score / NOVA when OFF provides |
| 4 | Food, OFF miss | Page-only scoring | `sources`: `page` |
| 5 | Non-food (electronics, etc.) | Eco score, leaf icon | Eco rationale list |
| 6 | Non-food, no eco signals | Eco ~50 | “Not enough data” message |
| 7 | Backend offline | Badge `?` / limited | Error or stale cache |
| 8 | Same ASIN revisit | Instant (extension `chrome.storage` + backend `data/cache.json`) | Same result |

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/health` | Liveness |
| POST | `/v1/analyze` | Product payload → `AnalysisResult` |

## Scoring (v1)

- **Health:** macros 35%, processing 20%, additives 25%, Nutri-Score 20%
- **Eco:** Material/ingredient composition only (no marketing claims or eco labels)
- **Ingredients:** `backend/data/additives.json` (red/green flags)

## Known limitations

- Amazon India only (`/dp/`, `/gp/product/`)
- DOM selectors may break when Amazon changes layout
- Incomplete OFF coverage for Indian barcodes
- Rule-based scores only (no LLM)
- `localhost` API in manifest — production needs HTTPS + updated permissions
- Amazon SPA navigation re-runs extraction on URL change

## Disclaimer

Informational only; not medical or environmental certification; not affiliated with Amazon.
