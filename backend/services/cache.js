import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = process.env.CACHE_FILE || join(__dirname, '..', 'data', 'cache.json');
const TTL_SECONDS = 7 * 24 * 60 * 60;
/** Bump when scoring/extraction logic changes to invalidate old cached results. */
export const CACHE_SCHEMA_VERSION = 'v12';

/** @type {Record<string, { payload: object, created_at: number }>} */
let memory = {};

function loadStore() {
  try {
    if (existsSync(CACHE_FILE)) {
      memory = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch {
    memory = {};
  }
}

function saveStore() {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(memory), 'utf8');
  } catch {
    /* ignore write errors in dev */
  }
}

loadStore();

export function cacheKey(payload) {
  const retailer = payload.retailer || 'unknown';
  if (payload.asin) return `${retailer}:${payload.asin}:${CACHE_SCHEMA_VERSION}`;
  if (payload.barcode) return `${retailer}:barcode:${payload.barcode}:${CACHE_SCHEMA_VERSION}`;
  return `${retailer}:url:${payload.url}:${CACHE_SCHEMA_VERSION}`;
}

export function getCached(key) {
  const now = Math.floor(Date.now() / 1000);
  const row = memory[key];
  if (!row) return null;
  if (now - row.created_at > TTL_SECONDS) {
    delete memory[key];
    saveStore();
    return null;
  }
  return row.payload;
}

export function setCached(key, result) {
  memory[key] = { payload: result, created_at: Math.floor(Date.now() / 1000) };
  saveStore();
}
