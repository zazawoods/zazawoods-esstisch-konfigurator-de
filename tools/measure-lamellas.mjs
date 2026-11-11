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

function snapGrid(prof, W) {
  const step = W / LAMELLAS_PER_TILE;
  const win = Math.round(step / 3);
  const seams = [];
  for (let k = 0; k < LAMELLAS_PER_TILE; k++) {
    const nominal = Math.round(k * step);
    let best = nominal, bestV = -1;
    for (let d = -win; d <= win; d++) {
      const x = (nominal + d + W) % W;
      if (prof[x] > bestV) { bestV = prof[x]; best = (nominal + d + W) % W; }
    }
    seams.push(best / W);
  }
  seams.sort((a, b) => a - b);
  // minimale onderlinge afstand bewaken (geen dubbele piek-vangst)
  for (let i = 1; i < seams.length; i++) {
    const minGap = 0.55 / LAMELLAS_PER_TILE;
    if (seams[i] - seams[i - 1] < minGap) seams[i] = seams[i - 1] + minGap;
  }
  if (seams[0] + 1 - seams[seams.length - 1] < 0.55 / LAMELLAS_PER_TILE) {
    seams[seams.length - 1] = seams[0] + 1 - 0.55 / LAMELLAS_PER_TILE;
  }
  return seams;
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
    const seams = usable ? snapGrid(prof, img.width) : (reference ? reference.slice() : null);
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
