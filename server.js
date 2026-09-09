const express = require('express');
const compression = require('compression');
const { writeFile, readFile, mkdir } = require('fs/promises');
const { randomBytes } = require('crypto');
const { existsSync } = require('fs');
const path = require('path');

const app = express();

// Hide Express signature for less info-leak
app.disable('x-powered-by');

// Extra security hardening
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Gzip/deflate compression for all responses. GLBs are Draco-compressed already
// (incompressible) — skip them so we don't burn CPU per request; everything
// else (HTML/CSS/JS/JSON/wasm) is compressed as usual.
app.use(compression({
  filter: (req, res) => {
    if (/\.(?:glb|usdz|png|jpe?g|webp|zip)(?:\?|$)/i.test(req.path)) return false;
    return compression.filter(req, res);
  }
}));
const PORT = process.env.PORT || 3000;
const TEMP_DIR = '/tmp/ar-models';

// CORS for API routes
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// Client diagnostics (mobile black-screen hunt): phones beacon lifecycle
// events here; the last 500 land in an in-memory ring buffer, readable via
// GET /api/clientlog. Ephemeral by design (resets on deploy), no PII.
const CLIENT_LOG = [];
app.post('/api/clientlog', (req, res) => {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > 16384) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    try {
      const msg = Buffer.concat(chunks).toString('utf8').slice(0, 8000);
      CLIENT_LOG.push({ at: new Date().toISOString(), msg });
      if (CLIENT_LOG.length > 500) CLIENT_LOG.splice(0, CLIENT_LOG.length - 500);
    } catch (e) { /* ignore */ }
    res.status(204).end();
  });
  req.on('error', () => { try { res.status(204).end(); } catch (e) {} });
});
app.get('/api/clientlog', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(CLIENT_LOG.slice(-300));
});

// Security & embedding headers for all other routes
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://zazawoods.de https://www.zazawoods.de https://zazawoods.nl https://www.zazawoods.nl https://zazawoods-esstisch-konfigurator-production.up.railway.app");
  }
  next();
});

// API: upload-glb
app.get('/api/upload-glb', async (req, res) => {
  const id = req.query.id;
  if (!id || !/^[a-f0-9]+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }
  try {
    const data = await readFile(`${TEMP_DIR}/${id}.glb`);
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Disposition', `inline; filename="table-${id}.glb"`);
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.status(200).send(data);
  } catch {
    return res.status(404).json({ error: 'Model not found or expired' });
  }
});

app.post('/api/upload-glb', async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length < 100) {
      return res.status(400).json({ error: 'Empty or invalid GLB' });
    }
    if (buffer.length > 20 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large (max 20MB)' });
    }

    const id = randomBytes(8).toString('hex');

    if (!existsSync(TEMP_DIR)) {
      await mkdir(TEMP_DIR, { recursive: true });
    }

    await writeFile(`${TEMP_DIR}/${id}.glb`, buffer);

    const host = req.headers.host || 'localhost:3000';
    const protocol = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
    const url = `${protocol}://${host}/api/upload-glb?id=${id}`;

    return res.status(200).json({ url, id });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// API: upload-usdz (POST) — hosts the client-exported USDZ so iOS Quick Look
// can open it via a plain URL (blob:/rel=ar links don't launch Quick Look from
// inside the shop iframe).
app.post('/api/upload-usdz', async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (buffer.length < 1000) return res.status(400).json({ error: 'Empty or invalid USDZ' });
    if (buffer.length > 30 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 30MB)' });
    const id = randomBytes(8).toString('hex');
    if (!existsSync(TEMP_DIR)) await mkdir(TEMP_DIR, { recursive: true });
    await writeFile(`${TEMP_DIR}/${id}.usdz`, buffer);
    const host = req.headers.host || 'localhost:3000';
    const protocol = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
    const url = `${protocol}://${host}/api/usdz/${id}.usdz`;
    return res.status(200).json({ url, id });
  } catch (err) {
    console.error('upload-usdz error:', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// Serve hosted USDZ with the exact MIME type Quick Look expects.
app.get('/api/usdz/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[a-f0-9]+\.usdz$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
  try {
    const data = await readFile(`${TEMP_DIR}/${name}`);
    res.setHeader('Content-Type', 'model/vnd.usdz+zip');
    res.setHeader('Content-Disposition', `inline; filename="zazawoods-tisch.usdz"`);
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.status(200).send(data);
  } catch {
    return res.status(404).json({ error: 'Model not found or expired' });
  }
});

// API: upload-icon (POST) — persists rendered PNG icons to /tmp/icons/
app.post('/api/upload-icon', async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (buffer.length < 100 || buffer.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'Invalid PNG size' });
    }
    const name = req.headers['x-icon-name'];
    if (!name || !/^[a-zA-Z0-9 _()äöüÄÖÜß,-]+\.png$/i.test(name)) {
      return res.status(400).json({ error: 'Invalid name header' });
    }
    const dir = '/tmp/icons';
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/${name}`, buffer);
    return res.status(200).json({ ok: true, name, size: buffer.length });
  } catch (err) {
    console.error('upload-icon error:', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// API: get icon file
app.get('/api/icon/:name', async (req, res) => {
  try {
    const name = req.params.name;
    if (!/^[a-zA-Z0-9 _()äöüÄÖÜß,-]+\.png$/i.test(name)) {
      return res.status(400).json({ error: 'Invalid name' });
    }
    const data = await readFile(`/tmp/icons/${name}`);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    return res.status(200).send(data);
  } catch {
    return res.status(404).json({ error: 'Icon not found' });
  }
});

// API: list icons
app.get('/api/icons', async (req, res) => {
  try {
    const { readdir } = require('fs/promises');
    const list = await readdir('/tmp/icons').catch(() => []);
    return res.status(200).json({ icons: list });
  } catch { return res.status(200).json({ icons: [] }); }
});

// ─── Live price sync ───────────────────────────────────────────────────────
// The configurator ships bundled prices in zw-products.json. Those can drift
// from Shopify whenever the owner edits a price. This endpoint mirrors the live
// storefront catalogue (/products.json) server-side into a variantId→price map,
// cached for LIVE_PRICE_TTL, so the configurator always shows the current shop
// price with NO redeploy. The client (shopify.js → app.js) overlays it onto the
// bundled prices; if this endpoint is ever unreachable the bundled prices are
// used unchanged (no regression).
//
// LIMITATION: Shopify *automatic* cart discounts (e.g. a "HERBST-SPECIAL" applied
// at checkout) are NOT part of /products.json and cannot be surfaced here. Only
// the regular price and, for a *scheduled sale*, compare_at_price are visible.
const SHOP_ORIGIN = process.env.SHOP_ORIGIN || 'https://zazawoods.de';
const LIVE_PRICE_TTL = 5 * 60 * 1000; // 5 minutes
let _livePriceCache = { at: 0, data: null, updatedAt: null };

// Fetch JSON with global fetch (Node ≥18) or a plain https fallback.
function fetchJSON(url) {
  if (typeof fetch === 'function') {
    return fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'zw-configurator-pricesync/1.0' } })
      .then(r => (r.ok ? r.json() : null));
  }
  return new Promise((resolve) => {
    try {
      const https = require('https');
      https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'zw-configurator-pricesync/1.0' } }, (r) => {
        if (r.statusCode !== 200) { r.resume(); return resolve(null); }
        let buf = '';
        r.setEncoding('utf8');
        r.on('data', (c) => { buf += c; if (buf.length > 12 * 1024 * 1024) r.destroy(); });
        r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); } });
      }).on('error', () => resolve(null));
    } catch (e) { resolve(null); }
  });
}

async function buildLivePriceMap() {
  const out = {};
  for (let page = 1; page <= 6; page++) {
    let json = null;
    try { json = await fetchJSON(`${SHOP_ORIGIN}/products.json?limit=250&page=${page}`); }
    catch (e) { break; }
    const products = (json && json.products) || [];
    if (!products.length) break;
    for (const p of products) {
      for (const v of (p.variants || [])) {
        const cents = Math.round(parseFloat(v.price) * 100);
        if (!Number.isFinite(cents) || cents <= 0) continue;
        const cmp = v.compare_at_price ? Math.round(parseFloat(v.compare_at_price) * 100) : null;
        out[String(v.id)] = (cmp && cmp > cents) ? { p: cents, c: cmp } : { p: cents };
      }
    }
    if (products.length < 250) break;
  }
  return out;
}

app.get('/api/live-prices', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  const stale = !_livePriceCache.data || (now - _livePriceCache.at) > LIVE_PRICE_TTL;
  if (stale || req.query.force === '1') {
    try {
      const data = await buildLivePriceMap();
      if (data && Object.keys(data).length) {
        _livePriceCache = { at: now, data, updatedAt: new Date().toISOString() };
      }
    } catch (e) { /* keep whatever we have */ }
  }
  if (!_livePriceCache.data) return res.status(200).json({ updatedAt: null, prices: {} });
  return res.status(200).json({ updatedAt: _livePriceCache.updatedAt, prices: _livePriceCache.data });
});

// Serve static files from /configurator (HTML/CSS/JS: no-cache, must revalidate every request).
// Mounted at BOTH "/" and "/configurator": index.html has <base href="/configurator/">, so the
// app requests /configurator/css/..., /configurator/js/..., while /ar.html & friends live at root.
const configuratorStatic = express.static(path.join(__dirname, 'configurator'), {
  etag: true,
  setHeaders: (res, filePath) => {
    if (/\.(?:html?|css|js|mjs|json)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      // textures/swatches/images/wasm: URLs carry ?v=BUILD_VERSION, safe to cache long
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
  }
});
app.use(configuratorStatic);
app.use('/configurator', configuratorStatic);

// Serve the 3D models (the only root-level folder the app references:
// config.js → `../glb files tables and legs/...`). Deliberately NOT the whole
// repo root any more — that exposed server.js, package.json, CSVs, HANDOFF docs
// and source zips publicly. GLB URLs carry ?v=BUILD_VERSION → cache 1 year.
app.use('/glb%20files%20tables%20and%20legs', express.static(path.join(__dirname, 'glb files tables and legs'), {
  etag: true,
  index: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));
app.use('/glb files tables and legs', express.static(path.join(__dirname, 'glb files tables and legs'), {
  etag: true,
  index: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

// Rewrite: root serves configurator index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'configurator', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Zaza Woods Esstisch-Konfigurator running on port ${PORT}`);
});
