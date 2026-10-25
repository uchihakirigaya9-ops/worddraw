/**
 * Wordprint - turns a photo into a portrait made of words.
 *
 * Pipeline
 *  1. Crop     : user pans/zooms the photo inside a fixed frame (canvas).
 *  2. Analyse  : downscale to a grid, compute grayscale tone, local contrast,
 *                Sobel edges + flow direction, and a silhouette mask
 *                (smart mode: background grown from the top corners, GrabCut-style
 *                colour models for background vs. subject, keep the central blob;
 *                optional green/red brush marks always override it).
 *  3. Place    : words are placed greedily, big to small. Every cell has a
 *                "target darkness" from the photo; a word is accepted only if
 *                the cells it covers still need ink and lie inside the mask.
 *                Words rotate to follow edges / the silhouette outline.
 *  4. Draw     : words are painted on a canvas at the chosen resolution.
 * Nothing is uploaded: everything runs locally in the browser.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const W = 900;      // virtual drawing width (all sizes are in these units)
  const GW = 420;     // analysis grid width in cells
  const FONTS = {
    caveat:     { face: '"Caveat"',         css: '"Caveat", "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive' },
    marker:     { face: '"Permanent Marker"', css: '"Permanent Marker", "Marker Felt", "Comic Sans MS", cursive' },
    typewriter: { face: '"Special Elite"',  css: '"Special Elite", "Courier New", monospace' },
    sans:       { face: '"Arial Black"',    css: '"Arial Black", Impact, "Helvetica Neue", sans-serif' },
    serif:      { face: 'Georgia',          css: 'Georgia, "Times New Roman", serif' },
  };

  const el = {};
  ['controls','file','drop','aspect','zoom','name','words','font','ink','bg','density','size','contrast',
   'tilt','follow','spacing','detail','maskMode','cut','hair','dark','outW','generate','regen','download','reset','status',
   'crop','out','empty','showMask','brushSize','clearPaint'].forEach((id) => (el[id] = $(id)));

  const state = { img: null, zoom: 1, base: 1, px: 0, py: 0, seed: 1, generated: false, paint: null, maskCv: null };
  let busy = false, pending = false;

  /* =====================================================================
   * 1. Photo upload and crop view
   * ===================================================================== */
  const view = el.crop, vctx = view.getContext('2d');
  const VW = 520, VH = 520;
  view.width = VW; view.height = VH;

  const aspect = () => { const [a, b] = el.aspect.value.split(':').map(Number); return a / b; };

  // The crop frame: centred rectangle with the chosen aspect ratio
  function frameRect() {
    const m = 28; let fw = VW - 2 * m, fh = fw / aspect();
    if (fh > VH - 2 * m) { fh = VH - 2 * m; fw = fh * aspect(); }
    return { x: (VW - fw) / 2, y: (VH - fh) / 2, w: fw, h: fh };
  }

  function fitImage() {
    const f = frameRect(), img = state.img;
    state.base = Math.max(f.w / img.naturalWidth, f.h / img.naturalHeight); // "cover"
    state.zoom = 1; state.px = f.x + f.w / 2; state.py = f.y + f.h / 2;
    el.zoom.value = 100; syncLabels();
  }

  function drawCrop() {
    vctx.fillStyle = '#dfe3ea'; vctx.fillRect(0, 0, VW, VH);
    if (!state.img) {
      vctx.fillStyle = '#5b6275'; vctx.font = '16px system-ui, sans-serif'; vctx.textAlign = 'center';
      vctx.fillText('Your photo will appear here', VW / 2, VH / 2);
      return;
    }
    const s = state.base * state.zoom, iw = state.img.naturalWidth * s, ih = state.img.naturalHeight * s;
    vctx.drawImage(state.img, state.px - iw / 2, state.py - ih / 2, iw, ih);
    const f = frameRect();
    vctx.save();                                   // dim everything outside the frame
    vctx.fillStyle = 'rgba(15,18,28,0.62)';
    vctx.beginPath(); vctx.rect(0, 0, VW, VH); vctx.rect(f.x, f.y, f.w, f.h); vctx.fill('evenodd');
    vctx.restore();
    if (el.showMask.checked && state.maskCv && !drag) {   // red tint = areas that will be left blank
      vctx.save(); vctx.beginPath(); vctx.rect(f.x, f.y, f.w, f.h); vctx.clip();
      vctx.imageSmoothingEnabled = true; vctx.drawImage(state.maskCv, f.x, f.y, f.w, f.h); vctx.restore();
    }
    if (state.paint) {                                     // brush marks: green = keep, red = erase
      vctx.save(); vctx.globalAlpha = 0.5; vctx.drawImage(state.paint, f.x, f.y, f.w, f.h); vctx.restore();
    }
    vctx.strokeStyle = '#fff'; vctx.lineWidth = 2; vctx.strokeRect(f.x, f.y, f.w, f.h);
    vctx.strokeStyle = 'rgba(255,255,255,0.3)'; vctx.lineWidth = 1; vctx.beginPath();
    for (let i = 1; i < 3; i++) {                  // rule-of-thirds guides
      vctx.moveTo(f.x + (f.w * i) / 3, f.y); vctx.lineTo(f.x + (f.w * i) / 3, f.y + f.h);
      vctx.moveTo(f.x, f.y + (f.h * i) / 3); vctx.lineTo(f.x + f.w, f.y + (f.h * i) / 3);
    }
    vctx.stroke();
  }

  function setZoom(z) {                            // zoom around the frame centre
    if (!state.img) return;
    z = clamp(z, 0.4, 5);
    const f = frameRect(), cx = f.x + f.w / 2, cy = f.y + f.h / 2, r = z / state.zoom;
    state.px = cx + (state.px - cx) * r; state.py = cy + (state.py - cy) * r; state.zoom = z;
    el.zoom.value = Math.round(z * 100); syncLabels(); drawCrop();
  }

  let drag = null, stroke = null;
  const tool = () => document.querySelector('input[name="tool"]:checked').value;   // pan | keep | erase

  function ensurePaint() {                         // brush layer lives in crop-frame coordinates
    const pw = 720, ph = Math.round(pw / aspect());
    if (!state.paint || state.paint.width !== pw || state.paint.height !== ph) {
      state.paint = document.createElement('canvas'); state.paint.width = pw; state.paint.height = ph;
    }
    return state.paint;
  }
  function paintAt(e, first) {
    const f = frameRect(), r = view.getBoundingClientRect(), k = VW / r.width;
    const x = ((e.clientX - r.left) * k - f.x) / f.w, y = ((e.clientY - r.top) * k - f.y) / f.h;
    const p = ensurePaint(), c = p.getContext('2d'), sc = p.width / f.w;
    c.lineCap = c.lineJoin = 'round'; c.lineWidth = el.brushSize.value * sc;
    c.strokeStyle = c.fillStyle = tool() === 'keep' ? '#00d060' : '#ff1744';
    if (tool() === 'keep' || tool() === 'erase') c.globalCompositeOperation = 'source-over';
    c.beginPath();
    if (first || !stroke) { c.arc(x * p.width, y * p.height, c.lineWidth / 2, 0, 7); c.fill(); }
    else { c.moveTo(stroke.x * p.width, stroke.y * p.height); c.lineTo(x * p.width, y * p.height); c.stroke(); }
    stroke = { x, y }; drawCrop();
  }

  view.addEventListener('pointerdown', (e) => {
    if (!state.img) return;
    view.setPointerCapture(e.pointerId);
    if (tool() !== 'pan') { stroke = null; drag = { paint: true }; paintAt(e, true); return; }
    drag = { x: e.clientX, y: e.clientY, px: state.px, py: state.py };
  });
  view.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.paint) { paintAt(e, false); return; }
    const k = VW / view.getBoundingClientRect().width;
    state.px = drag.px + (e.clientX - drag.x) * k; state.py = drag.py + (e.clientY - drag.y) * k;
    drawCrop();
  });
  ['pointerup', 'pointercancel'].forEach((t) => view.addEventListener(t, () => { if (drag) { drag = null; stroke = null; drawCrop(); schedule(); } }));
  view.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(state.zoom * (e.deltaY < 0 ? 1.06 : 0.94)); schedule(); }, { passive: false });
  el.zoom.addEventListener('input', () => { setZoom(el.zoom.value / 100); schedule(); });
  el.aspect.addEventListener('change', () => { if (state.img) { state.paint = null; state.maskCv = null; fitImage(); drawCrop(); schedule(); } });

  function loadFile(file) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return setStatus('Use a JPG, JPEG, PNG or WEBP image.', true);
    if (file.size > 30 * 1024 * 1024) return setStatus('That file is over 30 MB. Choose a smaller photo.', true);
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      state.img = img; state.generated = false; state.paint = null; state.maskCv = null; fitImage(); drawCrop();
      el.generate.disabled = false;
      setStatus('Photo loaded. Position it, type a name, then generate.');
    };
    img.onerror = () => { URL.revokeObjectURL(url); setStatus('That image could not be read. Try another file.', true); };
    img.src = url;
  }
  el.file.addEventListener('change', () => loadFile(el.file.files[0]));
  ['dragenter', 'dragover'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('over'); }));
  el.drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

  // Copy exactly what is inside the crop frame into a working canvas
  function getCropCanvas() {
    const f = frameRect(), cw = 720, ch = Math.round(cw / aspect());
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, cw, ch); x.imageSmoothingQuality = 'high';
    const k = cw / f.w, s = state.base * state.zoom * k;
    const iw = state.img.naturalWidth * s, ih = state.img.naturalHeight * s;
    x.drawImage(state.img, (state.px - f.x) * k - iw / 2, (state.py - f.y) * k - ih / 2, iw, ih);
    return c;
  }

  /* =====================================================================
   * 2. Image analysis (grayscale, contrast, edges, flow, silhouette mask)
   * ===================================================================== */
  function boxBlur(src, w, h, r) {                 // separable running-sum blur
    if (r < 1) return Float32Array.from(src);
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), k = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const o = y * w; let s = 0;
      for (let i = -r; i <= r; i++) s += src[o + clamp(i, 0, w - 1)];
      for (let x = 0; x < w; x++) { tmp[o + x] = s / k; s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[clamp(i, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) { out[y * w + x] = s / k; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
    }
    return out;
  }

  function gradient(s, w, h) {                     // Sobel
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = s[i - w - 1], b = s[i - w], c = s[i - w + 1], d = s[i - 1], f = s[i + 1], g = s[i + w - 1], hh = s[i + w], j = s[i + w + 1];
      gx[i] = (c + 2 * f + j) - (a + 2 * d + g);
      gy[i] = (g + 2 * hh + j) - (a + 2 * b + c);
    }
    return { gx, gy };
  }

  function percentile(arr, mask, p) {
    const v = []; for (let i = 0; i < arr.length; i++) if (!mask || mask[i]) v.push(arr[i]);
    if (!v.length) return 0;
    const t = Float32Array.from(v).sort(); return t[Math.min(t.length - 1, Math.floor(p * t.length))];
  }

  function otsu(vals) {                            // vals normalised to 0..1
    const bins = 64, hist = new Float64Array(bins);
    for (const v of vals) hist[Math.min(bins - 1, (v * bins) | 0)]++;
    let sum = 0; for (let i = 0; i < bins; i++) sum += i * hist[i];
    let wB = 0, sB = 0, max = -1, t = 0;
    for (let i = 0; i < bins; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = vals.length - wB; if (!wF) break;
      sB += i * hist[i];
      const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
      if (v > max) { max = v; t = i; }
    }
    return (t + 1) / bins;
  }

  function morph(bin, w, h, r, dilate) {           // square dilate / erode via blur
    const b = boxBlur(Float32Array.from(bin), w, h, r), out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = dilate ? (b[i] > 0.5 / ((2 * r + 1) ** 2) ? 1 : 0) : (b[i] > 0.995 ? 1 : 0);
    return out;
  }

  function largestComponent(bin, w, h) {
    const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
    let best = 0, bestId = 0, id = 0;
    for (let s = 0; s < bin.length; s++) {
      if (!bin[s] || lab[s]) continue;
      id++; let sp = 0, size = 0; stack[sp++] = s; lab[s] = id;
      while (sp) {
        const i = stack[--sp]; size++; const x = i % w, y = (i / w) | 0;
        if (x > 0 && bin[i - 1] && !lab[i - 1]) { lab[i - 1] = id; stack[sp++] = i - 1; }
        if (x < w - 1 && bin[i + 1] && !lab[i + 1]) { lab[i + 1] = id; stack[sp++] = i + 1; }
        if (y > 0 && bin[i - w] && !lab[i - w]) { lab[i - w] = id; stack[sp++] = i - w; }
        if (y < h - 1 && bin[i + w] && !lab[i + w]) { lab[i + w] = id; stack[sp++] = i + w; }
      }
      if (size > best) { best = size; bestId = id; }
    }
    const out = new Uint8Array(w * h);
    if (bestId) for (let i = 0; i < out.length; i++) out[i] = lab[i] === bestId ? 1 : 0;
    return out;
  }

  function fillHoles(bin, w, h) {                  // anything not reachable from the border is inside
    const out = Uint8Array.from(bin), seen = new Uint8Array(w * h), stack = new Int32Array(w * h); let sp = 0;
    const push = (i) => { if (!bin[i] && !seen[i]) { seen[i] = 1; stack[sp++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i / w) | 0;
      if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
    }
    for (let i = 0; i < out.length; i++) if (!bin[i] && !seen[i]) out[i] = 1;
    return out;
  }

  /* ---------- Smart subject segmentation (GrabCut-style colour models) ----------
   * Background colours are learned from the frame border (several clusters, so a
   * striped or patterned backdrop works); subject colours from the centre. Both
   * models are refined over a few rounds and smoothed spatially, then the most
   * subject-like blob (large AND near the centre) is kept, so stray logos,
   * corner decoration and halftone dots are dropped. */
  function kmeans(P, k, iters) {                    // P = flat [r,g,b,...]; farthest-point init
    const m = P.length / 3; if (!m) return [];
    const C = [[P[0], P[1], P[2]]], dmin = new Float32Array(m).fill(1e9);
    while (C.length < k) {
      let best = 0, bi = 0; const c = C[C.length - 1];
      for (let i = 0; i < m; i++) {
        const d = (P[i * 3] - c[0]) ** 2 + (P[i * 3 + 1] - c[1]) ** 2 + (P[i * 3 + 2] - c[2]) ** 2;
        if (d < dmin[i]) dmin[i] = d;
        if (dmin[i] > best) { best = dmin[i]; bi = i; }
      }
      if (best < 0.0004) break;
      C.push([P[bi * 3], P[bi * 3 + 1], P[bi * 3 + 2]]);
    }
    for (let it = 0; it < iters; it++) {
      const sum = C.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < m; i++) {
        let bj = 0, bd = 1e9;
        for (let j = 0; j < C.length; j++) {
          const d = (P[i * 3] - C[j][0]) ** 2 + (P[i * 3 + 1] - C[j][1]) ** 2 + (P[i * 3 + 2] - C[j][2]) ** 2;
          if (d < bd) { bd = d; bj = j; }
        }
        const q = sum[bj]; q[0] += P[i * 3]; q[1] += P[i * 3 + 1]; q[2] += P[i * 3 + 2]; q[3]++;
      }
      sum.forEach((q, j) => { if (q[3]) C[j] = [q[0] / q[3], q[1] / q[3], q[2] / q[3]]; });
    }
    return C;
  }

  function minDist(R, G, B, C, out) {               // distance to the nearest colour centre
    for (let i = 0; i < out.length; i++) {
      let bd = 1e9;
      for (let j = 0; j < C.length; j++) {
        const d = (R[i] - C[j][0]) ** 2 + (G[i] - C[j][1]) ** 2 + (B[i] - C[j][2]) ** 2;
        if (d < bd) bd = d;
      }
      out[i] = Math.sqrt(bd);
    }
  }

  function bestComponent(bin, w, h) {               // keep blobs scoring well on size x centrality
    const lab = new Int32Array(w * h), stack = new Int32Array(w * h), comps = [];
    let id = 0;
    for (let s0 = 0; s0 < bin.length; s0++) {
      if (!bin[s0] || lab[s0]) continue;
      id++; let sp = 0, size = 0, sx = 0, sy = 0; stack[sp++] = s0; lab[s0] = id;
      while (sp) {
        const i = stack[--sp]; size++; const x = i % w, y = (i / w) | 0; sx += x; sy += y;
        if (x > 0 && bin[i - 1] && !lab[i - 1]) { lab[i - 1] = id; stack[sp++] = i - 1; }
        if (x < w - 1 && bin[i + 1] && !lab[i + 1]) { lab[i + 1] = id; stack[sp++] = i + 1; }
        if (y > 0 && bin[i - w] && !lab[i - w]) { lab[i - w] = id; stack[sp++] = i - w; }
        if (y < h - 1 && bin[i + w] && !lab[i + w]) { lab[i + w] = id; stack[sp++] = i + w; }
      }
      comps.push({ id, size, cx: sx / size / w, cy: sy / size / h });
    }
    let bs = 0; const scores = comps.map((c) => {
      const d2 = ((c.cx - 0.5) / 0.5) ** 2 + ((c.cy - 0.6) / 0.6) ** 2;
      const sc = c.size * Math.exp(-d2 * 0.9); if (sc > bs) bs = sc; return sc;
    });
    const keep = new Uint8Array(id + 1);              // also keep big blobs near the best one (head vs. body, hair gaps)
    comps.forEach((c, k) => { if (scores[k] >= bs * 0.2) keep[c.id] = 1; });
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = lab[i] && keep[lab[i]] ? 1 : 0;
    return out;
  }

  function segmentSubject(R0, G0, B0, w, h, cut, reach) {
    const n = w * h, br = Math.max(1, Math.round(w / 140));
    const R = boxBlur(R0, w, h, br), G = boxBlur(G0, w, h, br), B = boxBlur(B0, w, h, br);   // tames halftone and noise

    // Background = everything connected to the top corners through smooth colour steps (region growing).
    // Border pixels alone are not trusted: shoulders and sleeves often touch the sides of the frame.
    const grown = new Uint8Array(n), stack = new Int32Array(n); let sp = 0;
    const cw = Math.max(3, Math.round(w * 0.10)), ch = Math.max(3, Math.round(h * 0.06));
    const corner = [];
    for (let y = 0; y < ch; y++) for (let x = 0; x < w; x++) if (x < cw || x >= w - cw) corner.push(R[y * w + x], G[y * w + x], B[y * w + x]);
    const cC = kmeans(corner, 3, 5);
    const nearCorner = (i) => { let d = 1e9; for (const c of cC) d = Math.min(d, Math.hypot(R[i] - c[0], G[i] - c[1], B[i] - c[2])); return d; };
    for (let y = 0; y < ch; y++) for (let x = 0; x < w; x++) {
      if (x < cw || x >= w - cw) { const i = y * w + x; if (nearCorner(i) < 0.2) { grown[i] = 1; stack[sp++] = i; } }
    }
    const lumS = new Float32Array(n);
    for (let i = 0; i < n; i++) lumS[i] = 0.299 * R0[i] + 0.587 * G0[i] + 0.114 * B0[i];
    const gE = gradient(boxBlur(lumS, w, h, 1), w, h), barrier = new Uint8Array(n);   // outlines stop the growth
    for (let i = 0; i < n; i++) barrier[i] = Math.hypot(gE.gx[i], gE.gy[i]) > 0.5 ? 1 : 0;
    const STEP = 0.06, CAP = 0.5;
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i / w) | 0;
      for (let k = 0; k < 4; k++) {
        const j = k === 0 ? (x > 0 ? i - 1 : -1) : k === 1 ? (x < w - 1 ? i + 1 : -1) : k === 2 ? (y > 0 ? i - w : -1) : (y < h - 1 ? i + w : -1);
        if (j < 0 || grown[j]) continue;
        if (!barrier[j] && Math.hypot(R[j] - R[i], G[j] - G[i], B[j] - B[i]) < STEP && nearCorner(j) < CAP) { grown[j] = 1; stack[sp++] = j; }
      }
    }
    const bgS = []; let gCount = 0;
    for (let i = 0; i < n; i++) if (grown[i]) { gCount++; if (i % 5 === 0) bgS.push(R[i], G[i], B[i]); }
    if (gCount < n * 0.03) return null;                 // no recognisable backdrop: let the caller fall back
    const bgRing = grown;
    let bgC = kmeans(bgS, 5, 6);
    const dB = new Float32Array(n), dF = new Float32Array(n);
    minDist(R, G, B, bgC, dB);

    const prior = new Float32Array(n);              // 1 at the centre, falling towards the edges
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (x / w - 0.5) / 0.5, dy = (y / h - 0.58) / 0.62;
      prior[y * w + x] = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
    }
    const fgS = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (prior[i] > 0.55 && dB[i] > 0.12 && (x + y) % 3 === 0) fgS.push(R[i], G[i], B[i]);
    }
    if (fgS.length < 90) return null;
    let fgC = kmeans(fgS, 6, 6);

    const s = new Float32Array(n), lab = new Uint8Array(n);
    const thr0 = ((cut - 50) / 50) * 0.3, reachR = Math.round((reach / 100) * 8);
    for (let round = 0; round < 4; round++) {
      minDist(R, G, B, bgC, dB); minDist(R, G, B, fgC, dF);
      for (let i = 0; i < n; i++) s[i] = (dB[i] - dF[i]) / (dB[i] + dF[i] + 0.02) + 0.3 * (prior[i] - 0.25);
      const sm = boxBlur(boxBlur(s, w, h, 2), w, h, 1);
      for (let i = 0; i < n; i++) lab[i] = sm[i] > thr0 ? 1 : 0;
      if (reachR > 0) {                             // hair and soft edges: more generous right next to the subject
        const near = morph(lab, w, h, reachR, true), relax = 0.22 * (reach / 100);
        for (let i = 0; i < n; i++) if (!lab[i] && near[i] && sm[i] > thr0 - relax) lab[i] = 1;
      }
      if (round < 3) {                              // re-learn both colour models from confident pixels
        const bgN = [], fgN = [];
        for (let i = 0; i < n; i += 2) {
          if (lab[i] && sm[i] > thr0 + 0.12) fgN.push(R[i], G[i], B[i]);
          else if (!lab[i] && (sm[i] < thr0 - 0.12 || bgRing[i])) bgN.push(R[i], G[i], B[i]);
        }
        if (fgN.length > 150 && bgN.length > 150) { fgC = kmeans(fgN, 6, 4); bgC = kmeans(bgN, 6, 4); }
      }
    }
    let bin = morph(morph(lab, w, h, 2, false), w, h, 2, true);          // remove specks
    bin = morph(morph(bin, w, h, 3, true), w, h, 3, false);              // close gaps
    return fillHoles(bestComponent(bin, w, h), w, h);
  }

  function segmentHalf(R, G, B, w, h, cut, reach) {   // 4x faster: segment at half size, then scale the mask up
    const w2 = w >> 1, h2 = h >> 1, n2 = w2 * h2;
    const r2 = new Float32Array(n2), g2 = new Float32Array(n2), b2 = new Float32Array(n2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      const i = (2 * y) * w + 2 * x, j = y * w2 + x;
      r2[j] = (R[i] + R[i + 1] + R[i + w] + R[i + w + 1]) / 4;
      g2[j] = (G[i] + G[i + 1] + G[i + w] + G[i + w + 1]) / 4;
      b2[j] = (B[i] + B[i + 1] + B[i + w] + B[i + w + 1]) / 4;
    }
    const small = segmentSubject(r2, g2, b2, w2, h2, cut, reach / 1);
    if (!small) return null;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = small[Math.min(h2 - 1, y >> 1) * w2 + Math.min(w2 - 1, x >> 1)];
    return out;
  }

  // Silhouette: "auto" (smart) | "simple" (plain background) | "oval" | "full"
  function buildMask(R, G, B, w, h, mode, cut, reach) {
    const n = w * h, mask = new Uint8Array(n);
    const oval = () => {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dx = (x / w - 0.5) / 0.42, dy = (y / h - 0.47) / 0.47;
        mask[y * w + x] = dx * dx + dy * dy <= 1 ? 1 : 0;
      }
    };
    if (mode === 'full') { mask.fill(1); return { mask, note: '' }; }
    if (mode === 'oval') { oval(); return { mask, note: '' }; }

    if (mode === 'auto') {
      const bin = segmentHalf(R, G, B, w, h, cut, reach);
      if (bin) {
        const sm = boxBlur(Float32Array.from(bin), w, h, 1);
        let count = 0;
        for (let i = 0; i < n; i++) { mask[i] = sm[i] > 0.5 ? 1 : 0; count += mask[i]; }
        if (count >= n * 0.06 && count <= n * 0.97) return { mask, note: '' };
      }
      // otherwise fall back to the plain-background method below
    }

    // Background colour = per-channel median of the border ring
    const bw = Math.max(2, Math.round(w * 0.04)), ring = [[], [], []];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x < bw || y < bw || x >= w - bw || y >= h - bw) { const i = y * w + x; ring[0].push(R[i]); ring[1].push(G[i]); ring[2].push(B[i]); }
    }
    const med = ring.map((a) => Float32Array.from(a).sort()[a.length >> 1]);
    const dist = new Float32Array(n);
    for (let i = 0; i < n; i++) dist[i] = Math.hypot(R[i] - med[0], G[i] - med[1], B[i] - med[2]);
    const dS = boxBlur(dist, w, h, 1); let dMax = 0;
    for (let i = 0; i < n; i++) if (dS[i] > dMax) dMax = dS[i];
    dMax = dMax || 1;
    const thr = otsu(Array.from(dS, (v) => v / dMax)) * dMax * (0.4 + (cut / 100) * 1.2);

    let strong = new Uint8Array(n);
    for (let i = 0; i < n; i++) strong[i] = dS[i] > thr ? 1 : 0;
    strong = morph(morph(strong, w, h, 2, false), w, h, 2, true);   // remove specks
    // Hair and soft edges: also accept weaker pixels that lie close to the solid subject
    const reachR = Math.round((reach / 100) * 14);
    let bin = strong;
    if (reachR > 0) {
      const near = morph(strong, w, h, reachR, true);
      bin = Uint8Array.from(strong);
      for (let i = 0; i < n; i++) if (near[i] && dS[i] > thr * 0.45) bin[i] = 1;
    }
    bin = morph(morph(bin, w, h, 3, true), w, h, 3, false);   // close gaps
    bin = fillHoles(largestComponent(bin, w, h), w, h);
    const sm = boxBlur(Float32Array.from(bin), w, h, 1);      // light smoothing keeps the hair outline
    let count = 0;
    for (let i = 0; i < n; i++) { mask[i] = sm[i] > 0.5 ? 1 : 0; count += mask[i]; }

    if (count < n * 0.1 || count > n * 0.95) {
      oval();
      return { mask, note: 'The person could not be separated from the background, so an oval was used. Try the cut-off slider or a different silhouette.' };
    }
    return { mask, note: '' };
  }

  function fold(a) { while (a > Math.PI / 2) a -= Math.PI; while (a <= -Math.PI / 2) a += Math.PI; return a; }

  // Brush marks always win over the automatic silhouette
  function applyPaint(mask, w, h) {
    if (!state.paint) return;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high'; x.drawImage(state.paint, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    for (let i = 0; i < w * h; i++) {
      if (d[i * 4 + 3] < 110) continue;
      mask[i] = d[i * 4 + 1] > d[i * 4] ? 1 : 0;          // green = keep, red = erase
    }
  }

  function analyze(cropC, o) {
    const w = GW, h = Math.round((GW * cropC.height) / cropC.width), n = w * h;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high'; x.drawImage(cropC, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), L = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      R[i] = d[i * 4] / 255; G[i] = d[i * 4 + 1] / 255; B[i] = d[i * 4 + 2] / 255;
      L[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];             // grayscale
    }
    const { mask, note } = buildMask(R, G, B, w, h, o.maskMode, o.cut, o.hair);
    applyPaint(mask, w, h);

    // Tone: auto-levels inside the silhouette + local contrast + user contrast
    const Lb = boxBlur(L, w, h, 1), Ls = boxBlur(boxBlur(L, w, h, 3), w, h, 3), Lbig = boxBlur(Lb, w, h, 14);
    const lo = percentile(Lb, mask, 0.02);
    let hi = percentile(Lb, mask, 0.98); if (hi - lo < 0.05) hi = lo + 0.05;
    const gain = 1 + o.contrast / 50, tone = new Float32Array(n);
    const hist = new Float64Array(256); let hn = 0;                    // histogram equalisation inside the subject
    for (let i = 0; i < n; i++) if (mask[i]) { hist[clamp((Lb[i] * 255) | 0, 0, 255)]++; hn++; }
    const cdf = new Float32Array(256); let acc = 0;
    for (let b = 0; b < 256; b++) { acc += hist[b]; cdf[b] = hn ? acc / hn : b / 255; }
    const eqMix = 0.25 + 0.4 * o.detail;
    for (let i = 0; i < n; i++) {
      const lin = clamp((Lb[i] - lo) / (hi - lo), 0, 1);
      const eq = cdf[clamp((Lb[i] * 255) | 0, 0, 255)];
      let t = lin * (1 - eqMix) + eq * eqMix + ((0.45 + 0.5 * o.detail) * (Lb[i] - Lbig[i])) / (hi - lo);
      t = clamp((t - 0.5) * gain + 0.5, 0, 1);
      tone[i] = 1 - t;                                               // 1 = darkest
    }

    // Edges, flow direction (structure tensor: smooth, so hair strands keep a direction) and outline
    const gi = gradient(boxBlur(L, w, h, 1), w, h), gm = gradient(boxBlur(Float32Array.from(mask), w, h, 2), w, h);
    const jxx = new Float32Array(n), jyy = new Float32Array(n), jxy = new Float32Array(n);
    const magI = new Float32Array(n), magM = new Float32Array(n);
    let maxM = 0;
    for (let i = 0; i < n; i++) {
      const gx = gi.gx[i], gy = gi.gy[i];
      jxx[i] = gx * gx; jyy[i] = gy * gy; jxy[i] = gx * gy;
      magI[i] = Math.sqrt(jxx[i] + jyy[i]); magM[i] = Math.hypot(gm.gx[i], gm.gy[i]);
      if (magM[i] > maxM) maxM = magM[i];
    }
    const sxx = boxBlur(jxx, w, h, 4), syy = boxBlur(jyy, w, h, 4), sxy = boxBlur(jxy, w, h, 4);
    const trace = new Float32Array(n);
    for (let i = 0; i < n; i++) trace[i] = sxx[i] + syy[i];
    const pI = percentile(magI, mask, 0.95) || 1, pT = percentile(trace, mask, 0.9) || 1;
    const mLoc = boxBlur(magI, w, h, 10);                              // local edge level: faint face lines count too
    const edge = new Float32Array(n), ang = new Float32Array(n), angW = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const eI = clamp(magI[i] / pI, 0, 1);
      const coh = Math.sqrt((sxx[i] - syy[i]) ** 2 + 4 * sxy[i] ** 2) / (trace[i] + 1e-9);   // how consistent the direction is
      const wI = clamp(coh * Math.sqrt(trace[i] / pT) * 1.6, 0, 1);
      const tI = 0.5 * Math.atan2(2 * sxy[i], sxx[i] - syy[i]) + Math.PI / 2;               // along the strands
      const wM = mask[i] ? clamp(magM[i] / ((maxM || 1) * 0.7), 0, 1) : 0;
      const tM = Math.atan2(gm.gy[i], gm.gx[i]) + Math.PI / 2;
      if (wM > wI) { ang[i] = fold(tM); angW[i] = wM; } else { ang[i] = fold(tI); angW[i] = wI; }
      const eL = clamp(magI[i] / (mLoc[i] * 2.5 + 0.12 * pI), 0, 1) * clamp(magI[i] / (0.12 * pI), 0, 1);
      edge[i] = Math.max(Math.pow(eI, 1.1), 0.85 * eL, wM * 0.9);
    }
    return { w, h, mask, tone, edge, ang, angW, R: boxBlur(R, w, h, 1), G: boxBlur(G, w, h, 1), B: boxBlur(B, w, h, 1), note };
  }

  /* =====================================================================
   * 3 + 4. Word placement and drawing
   * ===================================================================== */
  function mulberry32(a) {                          // seeded random: same seed = same layout
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const lum = (hex) => { const v = parseInt(hex.slice(1), 16); return (0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255; };

  // Colour mode: take the photo colour, boost saturation, keep it legible on the background
  function photoInk(r, g, b, darkBg) {
    const l = 0.299 * r + 0.587 * g + 0.114 * b, s = 1.4;
    r = clamp(l + (r - l) * s, 0, 1); g = clamp(l + (g - l) * s, 0, 1); b = clamp(l + (b - l) * s, 0, 1);
    if (!darkBg && l > 0.55) { const f = 0.55 / l; r *= f; g *= f; b *= f; }
    if (darkBg && l < 0.55) { const f = ((0.55 - l) / 0.55) * 0.7; r += (1 - r) * f; g += (1 - g) * f; b += (1 - b) * f; }
    return `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`;
  }

  function render(a, words, o) {
    const { w: gw, h: gh, mask } = a, asp = gw / gh, H = W / asp, g = W / gw;
    const out = el.out, outW = o.outW, outH = Math.round(outW / asp), k = outW / W;
    out.width = outW; out.height = outH;
    const ctx = out.getContext('2d');
    ctx.fillStyle = o.bg; ctx.fillRect(0, 0, outW, outH);

    const rand = mulberry32(o.seed);
    const darkBg = lum(o.bg) < 0.5, flip = o.mode === 'bw' ? lum(o.ink) > lum(o.bg) : darkBg;

    // Target ink per cell: darker (or, on dark paper, lighter) photo areas need more words
    const n = gw * gh, T = new Float32Array(n), cov = new Float32Array(n), cellsIdx = [];
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      cellsIdx.push(i);
      const t = flip ? 1 - a.tone[i] : a.tone[i];
      const deep = clamp((t - 0.5) / 0.4, 0, 1);               // hair and deep shadows
      T[i] = clamp((t * 1.15 + (0.3 + 0.9 * o.detail) * a.edge[i] + o.dark * 1.3 * deep * deep) * o.density, 0, 3.6);
    }
    if (!cellsIdx.length) return 0;
    const maskArea = cellsIdx.length * g * g;

    // Font metrics cache (width of each word at 100px)
    const wcache = new Map();
    const unitW = (text, wt) => {
      const key = wt + '|' + text;
      if (!wcache.has(key)) { ctx.font = `${wt} 100px ${o.font.css}`; wcache.set(key, ctx.measureText(text).width / 100); }
      return wcache.get(key);
    };

    // Passes go from big words to small ones; big words need a lot of unfilled darkness
    const passes = [
      { s: 3.0,  gap: 0.55, main: true },
      { s: 1.7,  gap: 0.42, mainP: 0.5 },
      { s: 1.1,  gap: 0.30, mainP: 0.35 },
      { s: 0.75, gap: 0.22, mainP: 0.3 },
      { s: 0.52, gap: 0.15, mainP: 0.3 },
      { s: 0.34, gap: 0.12, mainP: 0.25, fine: true },
    ];
    const foot = 0.45 + o.spacing * 0.8;            // spacing -> footprint thickness
    const scratch = new Int32Array(8000), placed = [];

    for (const p of passes) {
      if (p.fine && o.detail < 0.05) continue;
      const size0 = o.size * p.s;
      const attempts = Math.min(150000, Math.ceil((6 * maskArea) / (size0 * size0)));
      for (let at = 0; at < attempts; at++) {
        const ci = cellsIdx[(rand() * cellsIdx.length) | 0];
        if (p.fine && a.edge[ci] < 0.5 - 0.3 * o.detail) continue;   // fine words only where there is real detail
        if (T[ci] - cov[ci] < p.gap * 0.6) continue;           // quick reject: nothing to add here

        const cx = ci % gw, cy = (ci / gw) | 0;
        const x = (cx + rand()) * g, y = (cy + rand()) * g;
        const useMain = p.main || !words.extra.length || rand() < p.mainP;
        const text = useMain ? words.main : words.extra[(rand() * words.extra.length) | 0];
        const size = size0 * (0.88 + rand() * 0.27);
        const wt = p.main || a.tone[ci] > 0.55 ? 700 : 400;

        // Rotation: random tilt, blended toward the local contour direction
        const base = (rand() * 2 - 1) * o.tilt;
        const theta = base + fold(a.ang[ci] - base) * a.angW[ci] * o.follow;
        const cs = Math.cos(theta), sn = Math.sin(theta);

        // Which grid cells would this word cover?
        const L = unitW(text, wt) * size, th = size * foot;
        const nu = Math.max(1, Math.ceil(L / g)), nv = Math.max(1, Math.ceil(th / g));
        if (nu * nv > scratch.length) continue;
        let total = 0, inside = 0, gap = 0, light = 0;
        for (let i = 0; i < nu; i++) {
          const u = nu === 1 ? 0 : (i / (nu - 1) - 0.5) * L;
          for (let j = 0; j < nv; j++) {
            const v = nv === 1 ? 0 : (j / (nv - 1) - 0.5) * th;
            const gx = ((x + u * cs - v * sn) / g) | 0, gy = ((y + u * sn + v * cs) / g) | 0;
            total++;
            if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
            const idx = gy * gw + gx;
            if (mask[idx]) { scratch[inside++] = idx; gap += T[idx] - cov[idx]; if (T[idx] < 0.28) light++; }
          }
        }
        if (inside < total * 0.92 || gap / inside < p.gap) continue;   // outside silhouette or already dark enough
        if (light > inside * (p.s >= 1.7 ? 0.06 : p.s >= 0.75 ? 0.14 : 0.3)) continue;   // big words must not smudge light details (eyes, teeth, highlights)

        for (let i = 0; i < inside; i++) cov[scratch[i]] += 0.6;       // use up some of the cell's ink budget
        const tn = a.tone[ci];
        placed.push({
          t: text, x, y, s: size, r: theta, wt,
          a: clamp(0.62 + 0.38 * (flip ? 1 - tn : tn) + 0.15, 0.55, 1),   // lighter words in bright areas
          c: o.mode === 'color' ? photoInk(a.R[ci], a.G[ci], a.B[ci], darkBg) : o.ink,
        });
      }
    }

    // Small words first, so the big main name sits on top
    placed.sort((p, q) => p.s - q.s);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const wd of placed) {
      const c = Math.cos(wd.r) * k, s = Math.sin(wd.r) * k;
      ctx.setTransform(c, s, -s, c, wd.x * k, wd.y * k);
      ctx.globalAlpha = wd.a; ctx.fillStyle = wd.c;
      ctx.font = `${wd.wt} ${wd.s}px ${o.font.css}`;
      ctx.fillText(wd.t, 0, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
    return placed.length;
  }

  /* =====================================================================
   * Controls, generate, export, reset
   * ===================================================================== */
  function setStatus(msg, isError) { el.status.textContent = msg; el.status.classList.toggle('error', !!isError); }

  function syncLabels() {
    el.controls.querySelectorAll('.range').forEach((lab) => {
      const inp = lab.querySelector('input'), out = lab.querySelector('output');
      if (inp && out) out.textContent = inp.value + (inp.dataset.unit || '');
    });
  }

  // Strip control characters and angle brackets; words are only ever drawn on a canvas
  const clean = (s) => s.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  function parseWords() {
    return {
      main: clean(el.name.value),
      extra: el.words.value.split(/[\n,;]+/).map(clean).filter(Boolean).slice(0, 60),
    };
  }

  function readOptions() {
    return {
      mode: document.querySelector('input[name="mode"]:checked').value,
      ink: el.ink.value, bg: el.bg.value, font: FONTS[el.font.value],
      density: el.density.value / 100, size: +el.size.value, contrast: +el.contrast.value,
      tilt: (el.tilt.value * Math.PI) / 180, follow: el.follow.value / 100, spacing: el.spacing.value / 100, detail: el.detail.value / 100,
      maskMode: el.maskMode.value, cut: +el.cut.value, hair: +el.hair.value, dark: el.dark.value / 100, outW: +el.outW.value, seed: state.seed,
    };
  }

  async function ensureFont(font) {                 // wait for web fonts before measuring text
    if (!document.fonts) return;
    try {
      await Promise.race([
        Promise.all([document.fonts.load(`400 40px ${font.face}`), document.fonts.load(`700 40px ${font.face}`)]),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    } catch { /* fall back to system fonts */ }
  }

  function buildMaskPreview(a) {                    // red tint over everything the cut-out leaves blank
    const c = document.createElement('canvas'); c.width = a.w; c.height = a.h;
    const x = c.getContext('2d'), img = x.createImageData(a.w, a.h);
    for (let i = 0; i < a.w * a.h; i++) if (!a.mask[i]) { img.data[i * 4] = 220; img.data[i * 4 + 1] = 30; img.data[i * 4 + 2] = 60; img.data[i * 4 + 3] = 105; }
    x.putImageData(img, 0, 0); state.maskCv = c; drawCrop();
  }

  async function generate(fresh) {
    if (!state.img) return setStatus('Upload a photo first.', true);
    const words = parseWords();
    if (!words.main) { setStatus('Type a name to build the portrait from.', true); el.name.focus(); return; }
    if (busy) { pending = true; return; }
    busy = true; el.generate.disabled = true; setStatus('Generating…');
    if (fresh) state.seed = (Math.random() * 2 ** 31) | 0;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));   // let the UI repaint
    try {
      const opts = readOptions();
      await ensureFont(opts.font);
      const analysis = analyze(getCropCanvas(), opts);
      buildMaskPreview(analysis);
      const count = render(analysis, words, opts);
      state.generated = true;
      el.out.hidden = false; el.empty.hidden = true;
      el.regen.disabled = el.download.disabled = false;
      setStatus(`Done: ${count.toLocaleString()} words, ${el.out.width} × ${el.out.height} px. ${analysis.note}`.trim(), !!analysis.note);
    } catch (err) {
      console.error(err);
      setStatus('Something went wrong while generating. Try a smaller download size.', true);
    } finally {
      busy = false; el.generate.disabled = false;
      if (pending) { pending = false; generate(false); }
    }
  }

  let timer = null;                                  // live update after the first generate
  function schedule() { if (!state.generated) return; clearTimeout(timer); timer = setTimeout(() => generate(false), 350); }

  const quiet = (t) => t === el.file || t === el.zoom || t === el.brushSize || t === el.showMask || t.name === 'tool';
  el.controls.addEventListener('input', (e) => { syncLabels(); if (!quiet(e.target)) schedule(); });
  el.controls.addEventListener('change', (e) => {
    if (e.target === el.showMask) drawCrop();
    else if (e.target.name === 'tool') view.style.cursor = tool() === 'pan' ? '' : 'crosshair';
    else if (e.target.id === 'outW' || e.target.name === 'mode' || e.target.tagName === 'SELECT') schedule();
  });
  el.clearPaint.addEventListener('click', () => { state.paint = null; drawCrop(); schedule(); });
  el.generate.addEventListener('click', () => generate(false));
  el.regen.addEventListener('click', () => generate(true));

  el.download.addEventListener('click', () => {
    const slug = clean(el.name.value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'portrait';
    el.out.toBlob((blob) => {
      if (!blob) return setStatus('The image could not be exported. Try a smaller download size.', true);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `wordprint-${slug}-${el.out.width}x${el.out.height}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    }, 'image/png');
  });

  el.reset.addEventListener('click', () => {
    clearTimeout(timer);
    HTMLFormElement.prototype.reset.call(el.controls);   // (a button with id="reset" shadows form.reset)
    Object.assign(state, { img: null, generated: false, seed: 1, zoom: 1, paint: null, maskCv: null }); view.style.cursor = '';
    el.file.value = ''; syncLabels(); drawCrop();
    el.out.hidden = true; el.empty.hidden = false;
    el.generate.disabled = el.regen.disabled = el.download.disabled = true;
    setStatus('Ready. Upload a photo to begin.');
  });

  syncLabels(); drawCrop();
})();