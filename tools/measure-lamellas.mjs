// Meet lamelnaden in de eikenfoto's en schrijf configurator/js/oak-lamellas.js
//
// Aanpak: de nerf loopt in alle eikenfoto's verticaal (langs beeld-Y). Lamel-
// naden lopen dus ook verticaal. Per beeldkolom meten we de gemiddelde
// horizontale luminantie-gradiënt; naden/sterke nerflijnen geven pieken.
// We leggen een raster van ~7 lamellen per meter (foto = LAMELLA_PHOTO_M breed)
// en verankeren elke rasterlijn op de sterkste piek binnen ±1/3 lamelbreedte.
// Foto's zonder bruikbaar contrast (deep-black e.d.) erven de naden van
// 1-oil-plus-2c-oak-natural.jpg zodat kleurtint wél uit de eigen foto komt.
//
// Draaien:  node tools/measure-lamellas.mjs   (vanaf de repo-root)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jpeg from 'jpeg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OAK_DIR = path.join(ROOT, 'configurator', 'textures', 'oak');
const OUT = path.join(ROOT, 'configurator', 'js', 'oak-lamellas.js');

// Ware schaal van de (vierkante, naadloos tegelende) eikenfoto in meters.
// 1.40 m breed → bij lamellen van ±14 cm passen er 10 in één fototegel,
// dus gemiddeld 7 lamellen per strekkende meter bladbreedte.
const PHOTO_SIZE_M = 1.4;
const LAMELLAS_PER_TILE = 10;
const REFERENCE = '1-oil-plus-2c-oak-natural.jpg';
// Onder deze piek/ruis-verhouding beschouwen we een foto als "zonder nerf-
// contrast" en nemen we het referentieraster over.
const MIN_CONTRAST = 1.2;

function columnGradientProfile(img) {
  const { width: W, height: H, data } = img;
  const lum = (x, y) => {
    const i = (y * W + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  const prof = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    const xn = (x + 1) % W; // foto tegelt horizontaal: wrap
    let s = 0, n = 0;
    for (let y = 0; y < H; y += 2) { s += Math.abs(lum(xn, y) - lum(x, y)); n++; }
    prof[x] = s / n;
  }
  // licht smoothen (±2 px) met wrap
  const sm = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let d = -2; d <= 2; d++) s += prof[(x + d + W) % W];
    sm[x] = s / 5;
  }
  return sm;
}

// Detecteer waar een kijker een PLANKGRENS leest. Dat is niet de donkerste
// nerfstreep (die zit juist midden op een plank), maar de plek waar het
// karakter van het hout omslaat: gemiddelde toon én "streepjesdichtheid"
// (gradiënt-energie) veranderen daar sprongsgewijs. We scoren per kolom het
// verschil tussen het venster links en rechts en nemen de pieken daarvan.
function boundaryScore(img, prof) {
  const { width: W, height: H, data } = img;
  // kolomgemiddelde luminantie
  const colMean = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let y = 0; y < H; y += 2) {
      const i = (y * W + x) * 4;
      s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      n++;
    }
    colMean[x] = s / n;
  }
  // beide signalen licht smoothen (±6 px, wrap)
  const smooth = (src, r) => {
    const out = new Float64Array(W);
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += src[(x + d + W) % W];
      out[x] = s / (2 * r + 1);
    }
    return out;
  };
  const m = smooth(colMean, 6);
  const e = smooth(prof, 6);
  const std = (arr) => {
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - avg) * (b - avg), 0) / arr.length) || 1;
  };
  const sm = std(m), se = std(e);
  const w = 14; // ≈ 2 cm venster links/rechts
  const J = new Float64Array(W);
  const winAvg = (src, x0, x1) => {
    let s = 0, n = 0;
    for (let x = x0; x <= x1; x++) { s += src[(x + W) % W]; n++; }
    return s / n;
  };
  for (let x = 0; x < W; x++) {
    const dM = Math.abs(winAvg(m, x + 2, x + w) - winAvg(m, x - w, x - 2));
    const dE = Math.abs(winAvg(e, x + 2, x + w) - winAvg(e, x - w, x - 2));
    J[x] = dM / sm + dE / se;
  }
  return J;
}

function detectSeams(img, prof, W) {
  const minGapPx = Math.round((0.08 / PHOTO_SIZE_M) * W); // ≥ 8 cm tussen naden
  const J = boundaryScore(img, prof);
  const mean = J.reduce((a, b) => a + b, 0) / W;
  // lokale maxima (wrap) met prominentie boven het gemiddelde
  const peaks = [];
  for (let x = 0; x < W; x++) {
    const prev = J[(x - 1 + W) % W], next = J[(x + 1) % W];
    if (J[x] >= prev && J[x] > next && J[x] > mean * 1.15) {
      peaks.push([x, J[x]]);
    }
  }
  peaks.sort((a, b) => b[1] - a[1]);
  const chosen = [];
  for (const [x] of peaks) {
    let ok = true;
    for (const c of chosen) {
      const d = Math.min(Math.abs(x - c), W - Math.abs(x - c));
      if (d < minGapPx) { ok = false; break; }
    }
    if (ok) chosen.push(x);
    if (chosen.length >= 14) break; // nooit meer dan ~10/m
  }
  const prof2 = J; // ook gaten splitsen op de grens-score, niet op nerfstrepen
  // te weinig echte lijnen → vul aan met het oude raster als vangnet
  if (chosen.length < 5) {
    const step = W / LAMELLAS_PER_TILE;
    for (let k = 0; k < LAMELLAS_PER_TILE; k++) {
      const x = Math.round(k * step);
      if (chosen.every(c => Math.min(Math.abs(x - c), W - Math.abs(x - c)) >= minGapPx)) chosen.push(x);
    }
  }
  chosen.sort((a, b) => a - b);

  // Planken zijn in het echt 8–20 cm breed. Elke bredere tussenruimte bevat
  // op het blad nog duidelijk zichtbare lijnen die een kijker als planknaad
  // leest — splits zo'n gat dus op de sterkste lijn binnen dat stuk, net zo
  // lang tot geen enkele "plank" breder is dan ~20 cm.
  const maxGapPx = Math.round((0.20 / PHOTO_SIZE_M) * W);
  let guard = 0;
  while (guard++ < 40) {
    let splitAt = -1, gapStart = -1, gapEnd = -1;
    for (let i = 0; i < chosen.length; i++) {
      const a2 = chosen[i];
      const b2 = i + 1 < chosen.length ? chosen[i + 1] : chosen[0] + W; // wrap
      if (b2 - a2 > maxGapPx) { gapStart = a2; gapEnd = b2; break; }
    }
    if (gapStart < 0) break;
    let bestV = -1;
    for (let x = gapStart + minGapPx; x <= gapEnd - minGapPx; x++) {
      const xi = ((x % W) + W) % W;
      if (prof2[xi] > bestV) { bestV = prof2[xi]; splitAt = xi; }
    }
    if (splitAt < 0) break;
    chosen.push(splitAt);
    chosen.sort((a2, b2) => a2 - b2);
  }

  return chosen.map(x => x / W);
}

const files = fs.readdirSync(OAK_DIR).filter(f => f.endsWith('.jpg')).sort();
const result = {};
let reference = null;

// referentie eerst
for (const pass of [0, 1]) {
  for (const f of files) {
    if ((pass === 0) !== (f === REFERENCE)) continue;
    const img = jpeg.decode(fs.readFileSync(path.join(OAK_DIR, f)), { useTArray: true });
    const prof = columnGradientProfile(img);
    const mean = prof.reduce((a, b) => a + b, 0) / prof.length;
    const max = Math.max(...prof);
    const contrast = max / (mean || 1);
    const usable = (contrast >= MIN_CONTRAST && mean > 0.4) || f === REFERENCE;
    const seams = usable ? detectSeams(img, prof, img.width) : (reference ? reference.slice() : null);
    if (f === REFERENCE) reference = seams;
    result[f] = {
      seams: (seams || []).map(v => +v.toFixed(4)),
      measured: usable,
      contrast: +contrast.toFixed(2),
    };
    console.log(`${f}: contrast=${contrast.toFixed(2)} ${usable ? 'gemeten' : '→ referentieraster'}`);
  }
}

const body = `// GEGENEREERD door tools/measure-lamellas.mjs — niet met de hand bewerken.
// Lamelnaden per eikenfoto, als fracties van de fotobreedte (nerf loopt langs
// beeld-Y; naden dus verticaal). photoSizeM = ware breedte/hoogte van één
// fototegel in meters; ~${LAMELLAS_PER_TILE} lamellen per tegel ≈ 7 per meter.
export const OAK_PHOTO_SIZE_M = ${PHOTO_SIZE_M};
export const OAK_LAMELLAS = ${JSON.stringify(result, null, 2)};
`;
fs.writeFileSync(OUT, body);
console.log('geschreven:', OUT);
