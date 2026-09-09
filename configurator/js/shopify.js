// ─── Zaza Woods price helpers ─────────────────────
//
// The configurator's prices and variant IDs live in `zw-products.json` (loaded
// once by app.js as ZW_PRODUCTS_DATA). That file is bundled with the deploy so
// it is always available offline — no external Shopify fetch is required.
//
// The exports below are kept for backwards compatibility with app.js imports
// but no longer contact any Shopify storefront. If ZW_PRODUCTS_DATA is somehow
// missing, updatePrice() in app.js falls back to the last successful price it
// wrote to localStorage so the configurator stays visually functional.

const LAST_PRICE_KEY = 'zw_last_total_price';

// Read the last successful price we cached to localStorage (in EUR units).
export function getCachedTotal() {
  try {
    const raw = localStorage.getItem(LAST_PRICE_KEY);
    if (!raw) return 0;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) { return 0; }
}

// Persist a successful total so we can fall back to it later.
export function setCachedTotal(amountEUR) {
  try {
    if (Number.isFinite(amountEUR) && amountEUR > 0) {
      localStorage.setItem(LAST_PRICE_KEY, String(amountEUR));
    }
  } catch (e) { /* localStorage unavailable — ignore */ }
}

// Compatibility no-ops for legacy call sites in app.js. The real prices come
// from zw-products.json now, so fetchAllPrices resolves immediately and the
// calculateTotal fallback returns 0 (updatePrice reads the cache instead).
export async function fetchAllPrices() {
  console.log('[ZW] using bundled prices from zw-products.json');
  return {};
}

export function calculateTotal() { return 0; }

export function getLineItems() { return []; }

// Cart is built directly by app.js via the Zaza Woods /cart/ permalink using
// variant IDs from zw-products.json — no /myshopify.com/ redirects.
export async function addToCart() { return; }

export function formatPrice(amount) {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(amount);
}

// ─── Live price sync ──────────────────────────────────────────────────────
// Pulls the current shop prices from our own server (/api/live-prices), which
// mirrors the live storefront /products.json every few minutes. Returns a map
// variantId(string) → { p: priceCents, c?: compareAtCents }. On any failure it
// falls back to the last map cached in localStorage, and finally to {} (so the
// bundled zw-products.json prices are used unchanged — no regression).
//
// NOTE: Shopify *automatic* cart discounts do NOT appear in /products.json, so
// they cannot be reflected here; only the regular price and scheduled-sale
// compare_at_price are visible.
const LIVE_PRICES_KEY = 'zw_live_prices_v1';
export async function fetchLivePrices() {
  try {
    const r = await fetch('/api/live-prices', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j && j.prices && Object.keys(j.prices).length) {
        try { localStorage.setItem(LIVE_PRICES_KEY, JSON.stringify(j.prices)); } catch (e) {}
        console.log('[ZW] live prices loaded', Object.keys(j.prices).length, 'variants; updated', j.updatedAt);
        return j.prices;
      }
    }
  } catch (e) { console.warn('[ZW] live-prices fetch failed', e); }
  try {
    const raw = localStorage.getItem(LIVE_PRICES_KEY);
    if (raw) { const m = JSON.parse(raw); if (m && typeof m === 'object') return m; }
  } catch (e) {}
  return {};
}
