// ─── Massief-eiken weergave: doorlopende nerf + kopshout ───
//
// Dit module maakt van elk eiken tafelblad een "massieve" weergave:
//  • Bovenblad op WARE SCHAAL: de eikenfoto (OAK_PHOTO_SIZE_M breed) tegelt
//    in wereld-meters, dus lamellen zijn bij elke vorm/maat even breed.
//  • Lange zijden: zelfde foto, over de rand "omgevouwen" (nerf loopt zonder
//    naad door, nooit een lamelnaad als horizontale streep).
//  • Kopse kanten: gegenereerd kopshout (CanvasTexture) — per lamel
//    groeiringen rond een eigen hart, lamelgrenzen exact waar de naden van
//    het blad de kop kruisen, kleurtoon gesampled uit de lamel erboven.
//
// Faces worden per driehoek geclassificeerd (top/onder + lange zijde = groep 0,
// kop +X = groep 1, kop −X = groep 2) zodat de kop een eigen materiaal krijgt.
// De nerf loopt langs wereld-X (de tafellengte).

import * as THREE from 'three';

// ── kleine seeded RNG zodat ringen stabiel zijn per lamel/kleur ──
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ─── Classificatie + UV's ───────────────────────────────────────────────────
//
// Werkt op een BufferGeometry; worldMatrix mag null zijn als de geometry al in
// wereldruimte staat (custom extruded bladen). Resultaat: nieuwe non-indexed
// geometry met 3 groepen en real-scale UV's; info in geometry.userData.zwSolidOak.
export function classifySolidOakGeometry(srcGeometry, worldMatrix, opts) {
  const photoW = opts.photoW;
  const geo = srcGeometry.index ? srcGeometry.toNonIndexed() : srcGeometry.clone();
  const pos = geo.getAttribute('position');
  if (!pos || pos.count < 3) return null;

  const wm = worldMatrix || null;
  const v = new THREE.Vector3();
  const wpos = new Float32Array(pos.count * 3);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (wm) v.applyMatrix4(wm);
    wpos[i * 3] = v.x; wpos[i * 3 + 1] = v.y; wpos[i * 3 + 2] = v.z;
    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
  }
  const topY = maxY;
  const thickness = Math.max(maxY - minY, 0.005);
  const rangeZ = Math.max(maxZ - minZ, 0.005);

  // per driehoek: categorie bepalen via wereld-facenormaal
  const triCount = pos.count / 3;
  const cats = new Uint8Array(triCount); // 0 main, 1 end +X, 2 end −X
  const nzSign = new Int8Array(triCount); // teken van z-normaal (voor omvouw-UV)
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const counts = [0, 0, 0];
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3, i1 = t * 3 + 1, i2 = t * 3 + 2;
    a.set(wpos[i0 * 3], wpos[i0 * 3 + 1], wpos[i0 * 3 + 2]);
    b.set(wpos[i1 * 3], wpos[i1 * 3 + 1], wpos[i1 * 3 + 2]);
    c.set(wpos[i2 * 3], wpos[i2 * 3 + 1], wpos[i2 * 3 + 2]);
    e1.subVectors(b, a); e2.subVectors(c, a); n.crossVectors(e1, e2).normalize();
    let cat = 0;
    if (Math.abs(n.y) < 0.6 && Math.abs(n.x) > Math.abs(n.z)) cat = n.x > 0 ? 1 : 2;
    cats[t] = cat;
    nzSign[t] = n.z >= 0 ? 1 : -1;
    counts[cat]++;
  }

  // wereld-normalen per vertex (voor de vouw-beslissing op zijvlakken)
  const nAttr = geo.getAttribute('normal');
  const nm = wm ? new THREE.Matrix3().getNormalMatrix(wm) : null;
  const nTmp = new THREE.Vector3();
  const worldNy = (i) => {
    if (!nAttr) return 0;
    nTmp.set(nAttr.array[i * 3], nAttr.array[i * 3 + 1], nAttr.array[i * 3 + 2]);
    if (nm) nTmp.applyMatrix3(nm).normalize();
    return nTmp.y;
  };

  // nieuwe buffers in groepsvolgorde
  const srcAttrs = {};
  for (const name of ['position', 'normal', 'color']) {
    const at = geo.getAttribute(name);
    if (at) srcAttrs[name] = at;
  }
  const outAttrs = {};
  for (const name in srcAttrs) {
    outAttrs[name] = new Float32Array(pos.count * srcAttrs[name].itemSize);
  }
  const outUv = new Float32Array(pos.count * 2);

  const starts = [0, counts[0] * 3, (counts[0] + counts[1]) * 3];
  const cursor = [...starts];

  for (let t = 0; t < triCount; t++) {
    const cat = cats[t];
    const dst = cursor[cat]; cursor[cat] += 3;
    for (let k = 0; k < 3; k++) {
      const si = t * 3 + k, di = dst + k;
      for (const name in srcAttrs) {
        const at = srcAttrs[name], sz = at.itemSize;
        for (let m = 0; m < sz; m++) outAttrs[name][di * sz + m] = at.array[si * sz + m];
      }
      const wx = wpos[si * 3], wy = wpos[si * 3 + 1], wz = wpos[si * 3 + 2];
      let u, vv;
      if (cat === 0) {
        // nerf langs X: beeld-u = dwars (z), beeld-v = langs (x).
        // Zijvlakken worden over de bovenrand "omgevouwen" zodat de nerf
        // zonder naad doorloopt; top/ondervlak blijft puur planair.
        const useFold = Math.abs(worldNy(si)) < 0.82;
        const fold = useFold ? (topY - wy) * nzSign[t] : 0;
        u = ((wz + fold) / photoW) + 0.5;
        vv = (wx / photoW) + 0.5;
      } else {
        u = (wz - minZ) / rangeZ;
        vv = (wy - minY) / thickness; // v=1 bovenaan (canvas y=0 = bladoppervlak)
      }
      outUv[di * 2] = u; outUv[di * 2 + 1] = vv;
    }
  }

  const out = new THREE.BufferGeometry();
  for (const name in outAttrs) {
    out.setAttribute(name, new THREE.BufferAttribute(outAttrs[name], srcAttrs[name].itemSize, srcAttrs[name].normalized));
  }
  out.setAttribute('uv', new THREE.BufferAttribute(outUv, 2));
  out.clearGroups();
  out.addGroup(0, counts[0] * 3, 0);
  if (counts[1] > 0) out.addGroup(counts[0] * 3, counts[1] * 3, 1);
  if (counts[2] > 0) out.addGroup((counts[0] + counts[1]) * 3, counts[2] * 3, 2);
  out.userData.zwSolidOak = {
    minX, maxX, minZ, maxZ, topY, minY, thickness, rangeZ,
    hasEnds: counts[1] + counts[2] > 0,
  };
  if (geo !== srcGeometry) geo.dispose();
  return out;
}

// Hoofd-ingang voor een Mesh: bewaart pristine geometry, vervangt door de
// geclassificeerde versie. Idempotent: start altijd vanaf pristine.
export function classifySolidOakMesh(mesh, opts) {
  if (!mesh.isMesh || !mesh.geometry) return null;
  if (!mesh.userData.zwPristineGeo) mesh.userData.zwPristineGeo = mesh.geometry;
  const pristine = mesh.userData.zwPristineGeo;
  mesh.updateWorldMatrix(true, false);
  const classified = classifySolidOakGeometry(pristine, mesh.matrixWorld, opts);
  if (!classified) return null;
  if (mesh.geometry !== pristine) mesh.geometry.dispose();
  mesh.geometry = classified;
  return classified.userData.zwSolidOak;
}

// Terug naar de originele geometry (keramiek of fallback).
export function restorePristineGeometry(mesh) {
  const pristine = mesh.userData && mesh.userData.zwPristineGeo;
  if (!pristine) return false;
  if (mesh.geometry !== pristine) {
    mesh.geometry.dispose();
    mesh.geometry = pristine;
  }
  delete mesh.userData.zwPristineGeo;
  return true;
}

// ─── Kleur samplen uit de eikenfoto ────────────────────────────────────────
export function makeSampleCtx(image, size = 256) {
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, size, size);
  return ctx;
}

function sampleStripColor(sampleCtx, f0, f1) {
  const size = sampleCtx.canvas.width;
  const x0 = Math.max(0, Math.min(size - 1, Math.round(((f0 % 1) + 1) % 1 * size)));
  let w = Math.max(2, Math.round((f1 - f0) * size));
  if (x0 + w > size) w = size - x0;
  const data = sampleCtx.getImageData(x0, 0, Math.max(1, w), size).data;
  let r = 0, g = 0, b = 0, nPix = 0;
  for (let i = 0; i < data.length; i += 16) { r += data[i]; g += data[i + 1]; b += data[i + 2]; nPix++; }
  return [r / nPix, g / nPix, b / nPix];
}

// ─── Kopshout-canvas ───────────────────────────────────────────────────────
//
// z0..z1 = dwars-bereik (wereld-z) van het blad; lamelgrenzen = waar de
// gemeten naden van de bladfoto dit bereik kruisen (zelfde formule als de
// top-UV: u = z/photoW + 0.5).
export function buildEndgrainTexture(opts) {
  const {
    sampleCtx, seams, photoW, z0, z1, thickness,
    seed = 1, maxTex = 2048, anisotropy = 1,
  } = opts;
  const span = Math.max(z1 - z0, 0.05);
  let pxPerM = 1700;
  let W = Math.round(span * pxPerM);
  if (W > maxTex) { pxPerM = maxTex / span; W = maxTex; }
  W = Math.max(128, W);
  const H = Math.max(40, Math.min(256, Math.round(thickness * pxPerM * 1.6)));
  const pxPerMy = H / thickness;

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // lamelgrenzen in wereld-z
  const bounds = [z0];
  const sorted = [...seams].sort((x, y) => x - y);
  const nMin = Math.floor((z0 / photoW + 0.5) - 1);
  const nMax = Math.ceil((z1 / photoW + 0.5) + 1);
  for (let nTile = nMin; nTile <= nMax; nTile++) {
    for (const s of sorted) {
      const z = (s - 0.5 + nTile) * photoW;
      if (z > z0 + 0.02 && z < z1 - 0.02) bounds.push(z);
    }
  }
  bounds.push(z1);
  bounds.sort((x, y) => x - y);

  const rng0 = mulberry32(seed);
  for (let li = 0; li < bounds.length - 1; li++) {
    const zA = bounds[li], zB = bounds[li + 1];
    const xA = ((zA - z0) / span) * W, xB = ((zB - z0) / span) * W;
    const lamW = xB - xA;
    const rng = mulberry32((seed * 7919 + li * 104729) >>> 0);

    // basistoon uit de lamel erboven in de bladfoto
    const fA = ((zA / photoW + 0.5) % 1 + 1) % 1;
    const fB = fA + (zB - zA) / photoW;
    let [r, g, b] = sampleStripColor(sampleCtx, fA, Math.min(fB, fA + 0.999));
    // kopshout is iets donkerder/warmer dan langshout + lichte lamelvariatie
    const tone = 0.90 * (0.96 + rng() * 0.08);
    r *= tone; g *= tone * 0.985; b *= tone * 0.97;

    ctx.save();
    ctx.beginPath();
    ctx.rect(xA, 0, lamW + 0.5, H);
    ctx.clip();
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.fillRect(xA - 1, -1, lamW + 2, H + 2);

    // hart van de boom: onder, boven of opzij — per lamel anders, dicht genoeg
    // bij het blad zodat de bogen echt krommen
    const variant = rng();
    let hx, hy;
    if (variant < 0.45) {        // hart onder het blad
      hx = xA + lamW * (0.25 + rng() * 0.5);
      hy = H * (1.05 + rng() * 1.1);
    } else if (variant < 0.75) { // hart boven het blad
      hx = xA + lamW * (0.25 + rng() * 0.5);
      hy = -H * (0.1 + rng() * 1.0);
    } else {                     // hart opzij
      hx = (rng() < 0.5 ? xA - lamW * (0.05 + rng() * 0.3) : xB + lamW * (0.05 + rng() * 0.3));
      hy = H * (rng() * 1.6 - 0.3);
    }

    // groeiringen: ellipsbogen rond het hart, afstand ±3–7 mm met jitter
    const maxR = Math.hypot(Math.max(Math.abs(hx - xA), Math.abs(hx - xB)), Math.max(Math.abs(hy), Math.abs(hy - H))) + 4;
    const ringDark = 0.62 + rng() * 0.12;
    const yScale = pxPerMy / pxPerM; // ringen mee-schalen met niet-uniforme pixels
    let radius = (0.002 + rng() * 0.003) * pxPerM;
    let ringI = 0;
    while (radius < maxR && ringI < 400) {
      const alpha = 0.22 + rng() * 0.26;
      const lw = (0.0004 + rng() * 0.0007) * pxPerM;
      ctx.strokeStyle = `rgba(${(r * ringDark) | 0},${(g * ringDark) | 0},${(b * ringDark * 0.96) | 0},${alpha.toFixed(3)})`;
      ctx.lineWidth = Math.max(0.6, lw);
      ctx.beginPath();
      ctx.ellipse(hx, hy, radius, radius * yScale, 0, 0, Math.PI * 2);
      ctx.stroke();
      // af en toe een iets dikkere "laatjaar"-ring
      if (rng() < 0.18) {
        ctx.lineWidth = Math.max(0.8, lw * 1.8);
        ctx.strokeStyle = `rgba(${(r * (ringDark - 0.08)) | 0},${(g * (ringDark - 0.08)) | 0},${(b * (ringDark - 0.1)) | 0},${(alpha * 0.8).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(hx, hy, radius + ctx.lineWidth, (radius + ctx.lineWidth) * yScale, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      radius += (0.003 + rng() * 0.004) * pxPerM;
      ringI++;
    }

    // fijne korrel/speckles
    const specks = Math.round(lamW * H / 450);
    for (let sI = 0; sI < specks; sI++) {
      const sx = xA + rng() * lamW, sy = rng() * H;
      const dk = 0.8 + rng() * 0.3;
      ctx.fillStyle = `rgba(${(r * dk) | 0},${(g * dk) | 0},${(b * dk) | 0},0.12)`;
      ctx.fillRect(sx, sy, 1 + rng(), 1);
    }
    ctx.restore();
  }

  // subtiele schaduwval naar onderen (zoals geolied kops vlak)
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(255,255,255,0.05)');
  grad.addColorStop(1, 'rgba(0,0,0,0.07)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  void rng0;

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

export function endgrainSeed(colorId, side) {
  return (hashStr(colorId + '|' + side) % 100000) + 7;
}

// ─── USDZ-hulp: multi-materiaal meshes opsplitsen ──────────────────────────
// De USDZExporter van three r162 kan niet overweg met material-arrays +
// geometry groups; splits elke multi-materiaal mesh in één mesh per groep.
export function splitMultiMaterialMeshes(root) {
  const targets = [];
  root.traverse(o => {
    if (o.isMesh && Array.isArray(o.material) && o.geometry && o.geometry.groups && o.geometry.groups.length > 0) {
      targets.push(o);
    }
  });
  for (const mesh of targets) {
    const geo = mesh.geometry;
    const parent = mesh.parent;
    if (!parent) continue;
    for (const grp of geo.groups) {
      const mat = Array.isArray(mesh.material)
        ? (mesh.material[grp.materialIndex] || mesh.material[0])
        : mesh.material;
      const sub = new THREE.BufferGeometry();
      for (const name in geo.attributes) {
        const at = geo.attributes[name];
        const arr = at.array.slice(grp.start * at.itemSize, (grp.start + grp.count) * at.itemSize);
        sub.setAttribute(name, new THREE.BufferAttribute(arr, at.itemSize, at.normalized));
      }
      if (geo.index) {
        // onze solid-oak geometrie is non-indexed; indexed groups voor de
        // zekerheid ook ondersteunen
        const idx = [];
        for (let i = grp.start; i < grp.start + grp.count; i++) idx.push(geo.index.array[i]);
        const remap = new Map(); const order = [];
        for (const i of idx) if (!remap.has(i)) { remap.set(i, order.length); order.push(i); }
        for (const name in geo.attributes) {
          const at = geo.attributes[name];
          const arr = new Float32Array(order.length * at.itemSize);
          order.forEach((srcI, dstI) => {
            for (let m = 0; m < at.itemSize; m++) arr[dstI * at.itemSize + m] = at.array[srcI * at.itemSize + m];
          });
          sub.setAttribute(name, new THREE.BufferAttribute(arr, at.itemSize, at.normalized));
        }
        sub.setIndex(idx.map(i => remap.get(i)));
      }
      const subMesh = new THREE.Mesh(sub, mat);
      subMesh.name = mesh.name + '_g' + grp.materialIndex;
      subMesh.position.copy(mesh.position);
      subMesh.quaternion.copy(mesh.quaternion);
      subMesh.scale.copy(mesh.scale);
      subMesh.castShadow = mesh.castShadow;
      subMesh.receiveShadow = mesh.receiveShadow;
      parent.add(subMesh);
    }
    parent.remove(mesh);
  }
}
