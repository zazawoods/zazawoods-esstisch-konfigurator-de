// Controlehulp: tekent de gemeten naden als rode lijnen in de eikenfoto en
// schrijft het resultaat (in 2 helften) als JPEG, zodat je op volle resolutie
// kunt checken of elke lijn op een echte plankgrens ligt.
// Gebruik: node tools/seam-overlay.mjs <fotonaam.jpg> <uitvoermap>

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jpeg from 'jpeg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const name = process.argv[2] || '1-oil-plus-2c-oak-natural.jpg';
const outDir = process.argv[3] || path.join(ROOT, 'tools');

const lamMod = fs.readFileSync(path.join(ROOT, 'configurator/js/oak-lamellas.js'), 'utf8');
const data = JSON.parse(lamMod.slice(lamMod.indexOf('OAK_LAMELLAS = ') + 15).replace(/;\s*$/, ''));
const seams = data[name].seams;

const img = jpeg.decode(fs.readFileSync(path.join(ROOT, 'configurator/textures/oak', name)), { useTArray: true });
const { width: W, height: H } = img;
for (const s of seams) {
  const x = Math.round(s * W) % W;
  for (let y = 0; y < H; y++) {
    for (const dx of [0, 1]) {
      const i = (y * W + ((x + dx) % W)) * 4;
      img.data[i] = 255; img.data[i + 1] = 0; img.data[i + 2] = 0;
    }
  }
}
// in 2 helften (512 breed) wegschrijven voor leesbare inspectie
for (let half = 0; half < 2; half++) {
  const w2 = W / 2;
  const buf = Buffer.alloc(w2 * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < w2; x++) {
      const si = (y * W + half * w2 + x) * 4, di = (y * w2 + x) * 4;
      buf[di] = img.data[si]; buf[di + 1] = img.data[si + 1]; buf[di + 2] = img.data[si + 2]; buf[di + 3] = 255;
    }
  }
  const out = jpeg.encode({ data: buf, width: w2, height: H }, 90);
  fs.writeFileSync(path.join(outDir, `overlay_${name.replace(/\.jpg$/, '')}_${half}.jpg`), out.data);
}
console.log('overlays geschreven voor', name, '— naden:', seams.map(s => (s * 140).toFixed(0) + 'cm').join(', '));
