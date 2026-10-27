'use strict';
// SpriteForge — pixel-art editor that syncs sprites into a Unity project.

const $ = (id) => document.getElementById(id);
const DB32 = ['000000','222034','45283c','663931','8f563b','df7126','d9a066','eec39a','fbf236','99e550','6abe30','37946e',
  '4b692f','524b24','323c39','3f3f74','306082','5b6ee1','639bff','5fcde4','cbdbfc','ffffff','9badb7','847e87','696a6a',
  '595652','76428a','ac3232','d95763','d77bba','8f974a','8a6f30'];
const ZOOMS = [1, 2, 3, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64];

const TOOLS = [
  { id: 'select', icon: '⬚', key: 'M', name: 'Выделение' },
  { id: 'pencil', icon: '✎', key: 'B', name: 'Карандаш' },
  { id: 'eraser', icon: '⌫', key: 'E', name: 'Ластик' },
  { id: 'picker', icon: '⊙', key: 'I', name: 'Пипетка' },
  { id: 'move', icon: '✥', key: 'V', name: 'Перемещение' },
  { id: 'fill', icon: '◍', key: 'G', name: 'Заливка' },
  { id: 'line', icon: '╱', key: 'L', name: 'Линия' },
  { id: 'rect', icon: '▭', key: 'U', name: 'Прямоугольник' },
  { id: 'ellipse', icon: '◯', key: 'Shift+U', name: 'Эллипс' },
  { id: 'hand', icon: '✋', key: 'H / пробел', name: 'Рука (панорама)' },
];

// ---------------------------------------------------------------- document
let uid = 1;
const nid = () => uid++;
const doc = { w: 32, h: 32, layers: [], frames: [], pivot: 'center' };
const ui = {
  frame: 0, layer: 0, tool: 'pencil', zoom: 12, ox: 0, oy: 0,
  fg: [0, 0, 0, 255], bg: [255, 255, 255, 255], palette: DB32.map(hexToRgba), palSel: 0,
  sel: null, playing: false, onion: false, grid: true,
  hover: null, dirty: false, lastSavedRev: 0,
};
const history = { undo: [], redo: [] };

function newImage() { return new ImageData(doc.w, doc.h); }
function cloneImg(img) { return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height); }
function cel(frameIdx = ui.frame, layerIdx = ui.layer) {
  const f = doc.frames[frameIdx], l = doc.layers[layerIdx];
  if (!f.cels[l.id]) f.cels[l.id] = newImage();
  return f.cels[l.id];
}
function celEmpty(img) { if (!img) return true; const d = img.data; for (let i = 3; i < d.length; i += 4) if (d[i]) return false; return true; }

function resetDoc(w, h) {
  doc.w = w; doc.h = h; doc.pivot = 'center';
  doc.layers = [{ id: nid(), name: 'Layer 1', visible: true }];
  doc.frames = [{ id: nid(), duration: 100, cels: {} }];
  ui.frame = 0; ui.layer = 0; ui.sel = null;
  history.undo = []; history.redo = [];
  rebuildBuffers(); fitView(); refreshAll();
}

// ---------------------------------------------------------------- history
function snapshot() {
  return {
    w: doc.w, h: doc.h, pivot: doc.pivot, frame: ui.frame, layer: ui.layer,
    layers: doc.layers.map((l) => ({ ...l })),
    frames: doc.frames.map((f) => ({ id: f.id, duration: f.duration,
      cels: Object.fromEntries(Object.entries(f.cels).map(([k, v]) => [k, cloneImg(v)])) })),
  };
}
function restore(s) {
  const sizeChanged = s.w !== doc.w || s.h !== doc.h;
  doc.w = s.w; doc.h = s.h; doc.pivot = s.pivot;
  doc.layers = s.layers.map((l) => ({ ...l }));
  doc.frames = s.frames.map((f) => ({ id: f.id, duration: f.duration,
    cels: Object.fromEntries(Object.entries(f.cels).map(([k, v]) => [k, cloneImg(v)])) }));
  ui.frame = Math.min(s.frame, doc.frames.length - 1); ui.layer = Math.min(s.layer, doc.layers.length - 1);
  if (sizeChanged) { rebuildBuffers(); ui.sel = null; }
}
function pushHistory(entry) { history.undo.push(entry); if (history.undo.length > 100) history.undo.shift(); history.redo = []; changed(); }
function docOp(fn) { const before = snapshot(); fn(); pushHistory({ type: 'doc', before, after: snapshot() }); refreshAll(); }
function applyEntry(e, dir) {
  if (e.type === 'doc') restore(dir === 'undo' ? e.before : e.after);
  else {
    const fi = doc.frames.findIndex((f) => f.id === e.fid);
    if (fi < 0) return;
    doc.frames[fi].cels[e.lid] = cloneImg(dir === 'undo' ? e.before : e.after);
    ui.frame = fi; const li = doc.layers.findIndex((l) => l.id === e.lid); if (li >= 0) ui.layer = li;
  }
}
function undo() { const e = history.undo.pop(); if (!e) return; applyEntry(e, 'undo'); history.redo.push(e); changed(); refreshAll(); }
function redo() { const e = history.redo.pop(); if (!e) return; applyEntry(e, 'redo'); history.undo.push(e); changed(); refreshAll(); }

// ---------------------------------------------------------------- colors
function hexToRgba(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255]; }
function rgbaToHex(c) { return '#' + c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join(''); }
function rgbaCss(c) { return `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`; }
function sameColor(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]; }

// ---------------------------------------------------------------- pixel ops
function inSel(x, y) { const s = ui.sel; return !s || (x >= s.x && y >= s.y && x < s.x + s.w && y < s.y + s.h); }
function getPx(img, x, y) { const i = (y * img.width + x) * 4, d = img.data; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; }
function setPx(img, x, y, c) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || !inSel(x, y)) return;
  const i = (y * img.width + x) * 4, d = img.data;
  d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3];
}
const brushSize = () => +$('brushSize').value || 1;
function stamp(img, x, y, c, s = brushSize()) {
  if (s === 1) return setPx(img, x, y, c);
  const r = s / 2, off = Math.floor((s - 1) / 2), mid = (s - 1) / 2 - off;
  for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
    const cx = dx - off, cy = dy - off;
    if (s > 2 && (cx - mid) ** 2 + (cy - mid) ** 2 > r * r) continue;
    setPx(img, x + cx, y + cy, c);
  }
}
function linePts(x0, y0, x1, y1) {
  const pts = []; const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) { pts.push([x0, y0]); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } }
  return pts;
}
function drawRect(img, x0, y0, x1, y1, c, fill) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++)
    if (fill || x === ax || x === bx || y === ay || y === by) stamp(img, x, y, c);
}
function drawEllipse(img, x0, y0, x1, y1, c, fill) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const cx = (ax + bx) / 2, cy = (ay + by) / 2, rx = (bx - ax) / 2 + 0.5, ry = (by - ay) / 2 + 0.5;
  const inside = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
    if (!inside(x, y)) continue;
    if (fill || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) stamp(img, x, y, c);
  }
}
function floodFill(img, x, y, c) {
  const target = getPx(img, x, y); if (sameColor(target, c)) return;
  const w = img.width, h = img.height, stack = [[x, y]], seen = new Uint8Array(w * h);
  while (stack.length) {
    const [px, py] = stack.pop();
    if (px < 0 || py < 0 || px >= w || py >= h || seen[py * w + px] || !inSel(px, py)) continue;
    seen[py * w + px] = 1;
    if (!sameColor(getPx(img, px, py), target)) continue;
    setPx(img, px, py, c);
    stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
  }
}

// ---------------------------------------------------------------- rendering
const view = $('view'), vctx = view.getContext('2d');
const comp = document.createElement('canvas'), cctx = comp.getContext('2d');
const layerBuf = document.createElement('canvas'), lctx = layerBuf.getContext('2d');
let checker = null;

function rebuildBuffers() {
  comp.width = layerBuf.width = doc.w; comp.height = layerBuf.height = doc.h;
  const c = document.createElement('canvas'); c.width = doc.w * 2; c.height = doc.h * 2;
  const x = c.getContext('2d');
  for (let y = 0; y < doc.h * 2; y++) for (let i = 0; i < doc.w * 2; i++) { x.fillStyle = (i + y) % 2 ? '#c0c0c0' : '#ffffff'; x.fillRect(i, y, 1, 1); }
  checker = c;
}
function compose(target, frameIdx, alpha = 1) {
  const ctx = target.getContext('2d');
  const f = doc.frames[frameIdx];
  for (const l of doc.layers) {
    if (!l.visible || !f.cels[l.id]) continue;
    lctx.putImageData(f.cels[l.id], 0, 0);
    ctx.globalAlpha = alpha; ctx.drawImage(layerBuf, 0, 0); ctx.globalAlpha = 1;
  }
}
function render() {
  const dpr = window.devicePixelRatio || 1, rect = view.getBoundingClientRect();
  if (view.width !== Math.round(rect.width * dpr) || view.height !== Math.round(rect.height * dpr)) {
    view.width = Math.round(rect.width * dpr); view.height = Math.round(rect.height * dpr);
  }
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vctx.clearRect(0, 0, rect.width, rect.height);
  vctx.imageSmoothingEnabled = false;
  const z = ui.zoom, W = doc.w * z, H = doc.h * z;
  vctx.fillStyle = 'rgba(0,0,0,.35)'; vctx.fillRect(ui.ox + 3, ui.oy + 3, W, H);
  vctx.drawImage(checker, 0, 0, doc.w * 2, doc.h * 2, ui.ox, ui.oy, W, H);

  cctx.clearRect(0, 0, doc.w, doc.h);
  if (ui.onion && !ui.playing) {
    if (ui.frame > 0) compose(comp, ui.frame - 1, 0.28);
    if (ui.frame < doc.frames.length - 1) compose(comp, ui.frame + 1, 0.14);
  }
  compose(comp, ui.frame);
  vctx.drawImage(comp, ui.ox, ui.oy, W, H);

  if (ui.grid && z >= 6) {
    vctx.strokeStyle = 'rgba(0,0,0,.12)'; vctx.lineWidth = 1; vctx.beginPath();
    for (let x = 1; x < doc.w; x++) { vctx.moveTo(ui.ox + x * z + 0.5, ui.oy); vctx.lineTo(ui.ox + x * z + 0.5, ui.oy + H); }
    for (let y = 1; y < doc.h; y++) { vctx.moveTo(ui.ox, ui.oy + y * z + 0.5); vctx.lineTo(ui.ox + W, ui.oy + y * z + 0.5); }
    vctx.stroke();
  }
  vctx.strokeStyle = '#000'; vctx.strokeRect(ui.ox - 0.5, ui.oy - 0.5, W + 1, H + 1);

  if (ui.sel) {
    const s = ui.sel; vctx.save();
    vctx.setLineDash([4, 4]); vctx.lineDashOffset = -(performance.now() / 60) % 8;
    vctx.strokeStyle = '#fff'; vctx.strokeRect(ui.ox + s.x * z + 0.5, ui.oy + s.y * z + 0.5, s.w * z - 1, s.h * z - 1);
    vctx.lineDashOffset += 4; vctx.strokeStyle = '#000'; vctx.strokeRect(ui.ox + s.x * z + 0.5, ui.oy + s.y * z + 0.5, s.w * z - 1, s.h * z - 1);
    vctx.restore();
  }
  if (ui.hover && ['pencil', 'eraser', 'line', 'rect', 'ellipse'].includes(ui.tool) && !drag) {
    const s = +$('brushSize').value || 1, off = Math.floor((s - 1) / 2);
    vctx.strokeStyle = 'rgba(255,255,255,.85)';
    vctx.strokeRect(ui.ox + (ui.hover.x - off) * z + 0.5, ui.oy + (ui.hover.y - off) * z + 0.5, s * z - 1, s * z - 1);
  }
  renderPreview();
}
function renderPreview() {
  const pc = $('previewCanvas'), ctx = pc.getContext('2d');
  ctx.clearRect(0, 0, pc.width, pc.height); ctx.imageSmoothingEnabled = false;
  const sc = Math.max(1, Math.floor(Math.min(pc.width / doc.w, pc.height / doc.h)));
  const fi = previewPlaying ? previewFrame : ui.frame;
  cctx.clearRect(0, 0, doc.w, doc.h); compose(comp, Math.min(fi, doc.frames.length - 1));
  const x = (pc.width - doc.w * sc) / 2, y = (pc.height - doc.h * sc) / 2;
  ctx.drawImage(comp, x, y, doc.w * sc, doc.h * sc);
}
let rafPending = false;
function requestRender() { if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; render(); }); } }
setInterval(() => { if (ui.sel) requestRender(); }, 120);

function fitView() {
  ui.userView = false;
  const r = view.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return;
  const fit = Math.min((r.width - 40) / doc.w, (r.height - 40) / doc.h);
  ui.zoom = ZOOMS.filter((z) => z <= fit).pop() || 1;
  ui.ox = Math.round((r.width - doc.w * ui.zoom) / 2); ui.oy = Math.round((r.height - doc.h * ui.zoom) / 2);
}
function setZoom(nz, cx, cy) {
  const r = view.getBoundingClientRect();
  if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
  const px = (cx - ui.ox) / ui.zoom, py = (cy - ui.oy) / ui.zoom;
  ui.zoom = nz; ui.ox = Math.round(cx - px * nz); ui.oy = Math.round(cy - py * nz);
  ui.userView = true; updateStatus(); requestRender();
}
// Keep the sprite fitted while the layout settles or the window resizes, until the user zooms/pans.
new ResizeObserver(() => { if (!ui.userView) { fitView(); updateStatus(); } requestRender(); }).observe($('stage'));

// ---------------------------------------------------------------- input on canvas
let drag = null, spaceDown = false;
function toPx(e) {
  const r = view.getBoundingClientRect();
  return { x: Math.floor((e.clientX - r.left - ui.ox) / ui.zoom), y: Math.floor((e.clientY - r.top - ui.oy) / ui.zoom),
    sx: e.clientX - r.left, sy: e.clientY - r.top, pen: e.pointerType === 'pen', pressure: e.pressure };
}

// Graphics tablets (XP-Pen etc.): pen arrives as pointerType 'pen'. The eraser end reports button 5 / buttons bit 32,
// the barrel button acts like a right click. Touches right after pen use are treated as the palm and ignored.
let lastPenTime = 0, penInfo = null;
const isPenEraser = (e) => e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
function ignoreTouch(e) { return e.pointerType === 'touch' && ($('palmReject').checked || performance.now() - lastPenTime < 1500); }
function notePen(e) {
  if (e.pointerType !== 'pen') return;
  lastPenTime = performance.now();
  penInfo = { pressure: e.pressure, eraser: isPenEraser(e), tilt: [e.tiltX || 0, e.tiltY || 0] };
}

view.addEventListener('contextmenu', (e) => e.preventDefault());
view.addEventListener('pointerdown', (e) => {
  notePen(e);
  if (ignoreTouch(e) || drag) return;
  try { view.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  const p = toPx(e);
  if (e.button === 1 || spaceDown || ui.tool === 'hand') { drag = { kind: 'pan', sx: p.sx, sy: p.sy, ox: ui.ox, oy: ui.oy, pointerId: e.pointerId }; return; }
  if (ui.playing) stopPlay();
  const right = e.button === 2;
  let tool = ui.tool;
  if (e.altKey && ['pencil', 'fill', 'line', 'rect', 'ellipse'].includes(tool)) tool = 'picker';
  if (isPenEraser(e)) tool = 'eraser';
  const layer = doc.layers[ui.layer];
  if (['pencil', 'eraser', 'fill', 'line', 'rect', 'ellipse', 'move'].includes(tool) && !layer.visible) { toast('Слой скрыт — включите глаз в таймлайне'); return; }
  const color = tool === 'eraser' ? [0, 0, 0, 0] : (right ? ui.bg : ui.fg);
  const img = cel();
  const base = { kind: tool, start: p, last: p, color, before: cloneImg(img), fid: doc.frames[ui.frame].id, lid: layer.id, pointerId: e.pointerId };

  if (tool === 'picker') { pick(p, right); drag = { kind: 'picker', right }; return; }
  if (tool === 'select') { drag = { kind: 'select', start: p }; ui.sel = null; requestRender(); return; }
  if (tool === 'fill') { if (inBounds(p)) { floodFill(img, p.x, p.y, color); commitCel(base); } return; }
  if (tool === 'move') {
    const r = ui.sel || { x: 0, y: 0, w: doc.w, h: doc.h };
    const piece = new ImageData(r.w, r.h), src = base.before;
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const sx = r.x + x, sy = r.y + y; if (sx < 0 || sy < 0 || sx >= doc.w || sy >= doc.h) continue;
      const si = (sy * doc.w + sx) * 4, di = (y * r.w + x) * 4;
      for (let k = 0; k < 4; k++) piece.data[di + k] = src.data[si + k];
    }
    drag = { ...base, kind: 'move', rect: { ...r }, piece, hadSel: !!ui.sel };
    return;
  }
  drag = { ...base, pp: [] };
  if (tool === 'pencil' || tool === 'eraser') paintTo(p);
  else shapePreview(p, e.shiftKey);
  requestRender();
});
view.addEventListener('pointermove', (e) => {
  notePen(e);
  if (ignoreTouch(e) || (drag && drag.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
  const p = toPx(e);
  ui.hover = inBounds(p) ? p : null; updateStatus();
  if (!drag) { requestRender(); return; }
  if (drag.kind === 'pencil' || drag.kind === 'eraser') {
    // Tablets report ~200 Hz; coalesced events keep fast strokes continuous and pressure accurate.
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ce of evs.length ? evs : [e]) paintTo(toPx(ce));
    requestRender(); return;
  }
  if (drag.kind === 'pan') { ui.ox = drag.ox + p.sx - drag.sx; ui.oy = drag.oy + p.sy - drag.sy; ui.userView = true; requestRender(); return; }
  if (drag.kind === 'picker') { pick(p, drag.right); return; }
  if (drag.kind === 'select') {
    const x0 = clamp(Math.min(drag.start.x, p.x), 0, doc.w - 1), y0 = clamp(Math.min(drag.start.y, p.y), 0, doc.h - 1);
    const x1 = clamp(Math.max(drag.start.x, p.x), 0, doc.w - 1), y1 = clamp(Math.max(drag.start.y, p.y), 0, doc.h - 1);
    ui.sel = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; requestRender(); return;
  }
  if (drag.kind === 'move') { moveTo(p); return; }
  shapePreview(p, e.shiftKey);
  requestRender();
});
function endStroke(e) {
  if (!drag || (drag.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
  const d = drag; drag = null;
  if (['pencil', 'eraser', 'line', 'rect', 'ellipse'].includes(d.kind)) commitCel(d);
  if (d.kind === 'move' && (d.dx || d.dy)) commitCel(d);
  if (d.kind === 'select' && ui.sel && ui.sel.w * ui.sel.h <= 1 && d.start) ui.sel = null;
  requestRender();
}
view.addEventListener('pointerup', endStroke);
// Windows Ink gestures can cancel a pen stroke; keep what was drawn instead of leaving the stroke open.
view.addEventListener('pointercancel', endStroke);
view.addEventListener('pointerleave', () => { ui.hover = null; updateStatus(); requestRender(); });
view.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = view.getBoundingClientRect();
  if (e.ctrlKey || !e.shiftKey) {
    const i = ZOOMS.indexOf(ui.zoom), ni = clamp((i < 0 ? 5 : i) + (e.deltaY < 0 ? 1 : -1), 0, ZOOMS.length - 1);
    setZoom(ZOOMS[ni], e.clientX - r.left, e.clientY - r.top);
  } else { ui.ox -= e.deltaY; requestRender(); }
}, { passive: false });

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const inBounds = (p) => p.x >= 0 && p.y >= 0 && p.x < doc.w && p.y < doc.h;

function paintTo(p) {
  const img = cel(), pts = linePts(drag.last.x, drag.last.y, p.x, p.y);
  const size = p.pen && $('pressureSize').checked ? Math.max(1, Math.round(brushSize() * Math.min(1, p.pressure * 1.25))) : brushSize();
  const perfect = $('pixelPerfect').checked && size === 1;
  for (const [x, y] of pts) {
    const pp = drag.pp, last = pp[pp.length - 1];
    if (last && last.x === x && last.y === y) continue;
    if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) { pp.length = 0; continue; }
    const prev = getPx(img, x, y);
    stamp(img, x, y, drag.color, size);
    pp.push({ x, y, prev });
    if (perfect && pp.length >= 3) {
      const a = pp[pp.length - 3], b = pp[pp.length - 2], c = pp[pp.length - 1];
      const adj = (u, v) => Math.abs(u.x - v.x) + Math.abs(u.y - v.y) === 1;
      if (adj(a, b) && adj(b, c) && Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1) {
        setPx(img, b.x, b.y, b.prev); pp.splice(pp.length - 2, 1);
      }
    }
  }
  drag.last = p;
}
function shapePreview(p, shift) {
  const img = cel(); img.data.set(drag.before.data);
  let { x: x0, y: y0 } = drag.start, x1 = p.x, y1 = p.y;
  if (shift) {
    if (drag.kind === 'line') {
      const dx = x1 - x0, dy = y1 - y0, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.max(Math.abs(dx), Math.abs(dy));
      x1 = x0 + Math.round(Math.cos(ang) * len); y1 = y0 + Math.round(Math.sin(ang) * len);
    } else { const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); x1 = x0 + Math.sign(x1 - x0 || 1) * s; y1 = y0 + Math.sign(y1 - y0 || 1) * s; }
  }
  const fill = $('fillShape').checked;
  if (drag.kind === 'line') for (const [x, y] of linePts(x0, y0, x1, y1)) stamp(img, x, y, drag.color);
  else if (drag.kind === 'rect') drawRect(img, x0, y0, x1, y1, drag.color, fill);
  else drawEllipse(img, x0, y0, x1, y1, drag.color, fill);
}
function moveTo(p) {
  const img = cel(), r = drag.rect, dx = p.x - drag.start.x, dy = p.y - drag.start.y;
  drag.dx = dx; drag.dy = dy;
  img.data.set(drag.before.data);
  ui.sel = null; // setPx clips to the selection; the moved piece may leave it
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) setPx(img, x, y, [0, 0, 0, 0]);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const i = (y * r.w + x) * 4, a = drag.piece.data[i + 3]; if (!a) continue;
    setPx(img, r.x + x + dx, r.y + y + dy, [drag.piece.data[i], drag.piece.data[i + 1], drag.piece.data[i + 2], a]);
  }
  ui.sel = drag.hadSel ? { ...r, x: r.x + dx, y: r.y + dy } : null;
  requestRender();
}
function commitCel(d) {
  const img = cel();
  if (img.data.every((v, i) => v === d.before.data[i])) return;
  pushHistory({ type: 'cel', fid: d.fid, lid: d.lid, before: d.before, after: cloneImg(img) });
  refreshTimeline(); requestRender();
}
function pick(p, right) {
  if (!inBounds(p)) return;
  cctx.clearRect(0, 0, doc.w, doc.h); compose(comp, ui.frame);
  const c = Array.from(cctx.getImageData(p.x, p.y, 1, 1).data);
  if (c[3] === 0) return;
  if (right) ui.bg = c; else ui.fg = c;
  refreshColors();
}

// ---------------------------------------------------------------- commands
const cmds = {
  new: () => dlgNew(), open: () => dlgOpen(), save: () => saveToUnity(true), settings: () => dlgSettings(),
  exportPng: () => exportPng(), importPng: () => $('fileInput').click(), resize: () => dlgResize(),
  exportProject: () => dlgExportProject(), openFile: () => $('projectInput').click(),
  play: () => (ui.playing ? stopPlay() : startPlay()),
  firstFrame: () => goFrame(0), lastFrame: () => goFrame(doc.frames.length - 1),
  prevFrame: () => goFrame((ui.frame - 1 + doc.frames.length) % doc.frames.length),
  nextFrame: () => goFrame((ui.frame + 1) % doc.frames.length),
  newFrame: () => docOp(() => {
    const f = doc.frames[ui.frame];
    doc.frames.splice(ui.frame + 1, 0, { id: nid(), duration: f.duration, cels: Object.fromEntries(Object.entries(f.cels).map(([k, v]) => [k, cloneImg(v)])) });
    ui.frame++;
  }),
  emptyFrame: () => docOp(() => { doc.frames.splice(ui.frame + 1, 0, { id: nid(), duration: doc.frames[ui.frame].duration, cels: {} }); ui.frame++; }),
  delFrame: () => { if (doc.frames.length > 1) docOp(() => { doc.frames.splice(ui.frame, 1); ui.frame = Math.min(ui.frame, doc.frames.length - 1); }); },
  frameLeft: () => { if (ui.frame > 0) docOp(() => { const f = doc.frames.splice(ui.frame, 1)[0]; doc.frames.splice(--ui.frame, 0, f); }); },
  frameRight: () => { if (ui.frame < doc.frames.length - 1) docOp(() => { const f = doc.frames.splice(ui.frame, 1)[0]; doc.frames.splice(++ui.frame, 0, f); }); },
  newLayer: () => docOp(() => { doc.layers.splice(ui.layer + 1, 0, { id: nid(), name: 'Layer ' + (doc.layers.length + 1), visible: true }); ui.layer++; }),
  delLayer: () => { if (doc.layers.length > 1) docOp(() => { const l = doc.layers.splice(ui.layer, 1)[0]; doc.frames.forEach((f) => delete f.cels[l.id]); ui.layer = Math.max(0, ui.layer - 1); }); },
  layerUp: () => { if (ui.layer < doc.layers.length - 1) docOp(() => { const l = doc.layers.splice(ui.layer, 1)[0]; doc.layers.splice(++ui.layer, 0, l); }); },
  layerDown: () => { if (ui.layer > 0) docOp(() => { const l = doc.layers.splice(ui.layer, 1)[0]; doc.layers.splice(--ui.layer, 0, l); }); },
};
document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => cmds[b.dataset.cmd]()));

function goFrame(i) { ui.frame = clamp(i, 0, doc.frames.length - 1); refreshTimeline(); requestRender(); updateStatus(); }
let playTimer = null;
function startPlay() {
  ui.playing = true; $('playBtn').textContent = '■';
  const step = () => { ui.frame = (ui.frame + 1) % doc.frames.length; refreshTimeline(); requestRender(); playTimer = setTimeout(step, doc.frames[ui.frame].duration); };
  playTimer = setTimeout(step, doc.frames[ui.frame].duration);
}
function stopPlay() { ui.playing = false; clearTimeout(playTimer); $('playBtn').textContent = '▶'; refreshTimeline(); requestRender(); }

let previewPlaying = true, previewFrame = 0, previewTimer = null;
function previewTick() {
  previewFrame = (previewFrame + 1) % doc.frames.length;
  renderPreview();
  previewTimer = setTimeout(previewTick, doc.frames[previewFrame]?.duration || 100);
}
$('previewPlay').addEventListener('click', () => {
  previewPlaying = !previewPlaying; $('previewPlay').textContent = previewPlaying ? '■' : '▶';
  clearTimeout(previewTimer); if (previewPlaying) previewTick(); else renderPreview();
});

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') && !(e.ctrlKey && e.key.toLowerCase() === 's')) return;
  const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
  if (k === ' ') { spaceDown = true; view.style.cursor = 'grab'; e.preventDefault(); return; }
  if (ctrl) {
    const map = { z: e.shiftKey ? redo : undo, y: redo, s: () => saveToUnity(true), o: dlgOpen, n: dlgNew,
      a: () => { ui.sel = { x: 0, y: 0, w: doc.w, h: doc.h }; requestRender(); },
      d: () => { ui.sel = null; requestRender(); }, c: copySel, x: () => { copySel(); clearSel(); }, v: pasteSel };
    if (map[k]) { e.preventDefault(); map[k](); }
    return;
  }
  if (e.altKey) {
    const map = { n: cmds.newFrame, b: cmds.emptyFrame, c: cmds.delFrame };
    if (map[k]) { e.preventDefault(); map[k](); }
    return;
  }
  if (e.shiftKey && k === 'n') return cmds.newLayer();
  if (e.shiftKey && k === 'u') return setTool('ellipse');
  const toolKeys = { m: 'select', b: 'pencil', e: 'eraser', i: 'picker', v: 'move', g: 'fill', l: 'line', u: 'rect', h: 'hand' };
  if (toolKeys[k]) return setTool(toolKeys[k]);
  if (k === 'x') { [ui.fg, ui.bg] = [ui.bg, ui.fg]; return refreshColors(); }
  if (k === ',') return cmds.prevFrame();
  if (k === '.') return cmds.nextFrame();
  if (k === 'enter') return cmds.play();
  if (k === 'delete' || k === 'backspace') return clearSel();
  if (k === '[') { $('brushSize').value = Math.max(1, +$('brushSize').value - 1); return requestRender(); }
  if (k === ']') { $('brushSize').value = Math.min(32, +$('brushSize').value + 1); return requestRender(); }
  if (k === '+' || k === '=') return setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(ui.zoom) + 1)]);
  if (k === '-') return setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(ui.zoom) - 1)]);
  if (k === '0') { fitView(); updateStatus(); return requestRender(); }
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; view.style.cursor = ''; } });

let clipboard = null;
function copySel() {
  const r = ui.sel || { x: 0, y: 0, w: doc.w, h: doc.h }, img = cel(), out = new ImageData(r.w, r.h);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const c = getPx(img, r.x + x, r.y + y); out.data.set(c, (y * r.w + x) * 4); }
  clipboard = { img: out, x: r.x, y: r.y }; toast('Скопировано');
}
function clearSel() {
  const img = cel(), d = { before: cloneImg(img), fid: doc.frames[ui.frame].id, lid: doc.layers[ui.layer].id };
  const r = ui.sel || { x: 0, y: 0, w: doc.w, h: doc.h };
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) setPx(img, x, y, [0, 0, 0, 0]);
  commitCel(d);
}
function pasteSel() {
  if (!clipboard) return;
  const img = cel(), d = { before: cloneImg(img), fid: doc.frames[ui.frame].id, lid: doc.layers[ui.layer].id };
  const { img: c, x: px, y: py } = clipboard; ui.sel = null;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const i = (y * c.width + x) * 4; if (c.data[i + 3]) setPx(img, px + x, py + y, Array.from(c.data.slice(i, i + 4)));
  }
  ui.sel = { x: px, y: py, w: c.width, h: c.height }; commitCel(d); setTool('move');
}

// ---------------------------------------------------------------- UI panels
function setTool(t) { ui.tool = t; document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === t)); view.style.cursor = t === 'hand' ? 'grab' : 'crosshair'; requestRender(); }
function buildTools() {
  $('tools').innerHTML = '';
  for (const t of TOOLS) {
    const b = document.createElement('button'); b.textContent = t.icon; b.title = `${t.name} (${t.key})`; b.dataset.tool = t.id;
    b.onclick = () => setTool(t.id); $('tools').appendChild(b);
  }
  setTool(ui.tool);
}
function refreshPalette() {
  const el = $('palette'); el.innerHTML = '';
  ui.palette.forEach((c, i) => {
    const d = document.createElement('div'); d.style.background = rgbaCss(c); d.title = rgbaToHex(c);
    if (sameColor(c, ui.fg)) d.classList.add('fg');
    if (sameColor(c, ui.bg)) d.classList.add('bg');
    d.onmousedown = (e) => { e.preventDefault(); ui.palSel = i; if (e.button === 2) ui.bg = [...c]; else ui.fg = [...c]; refreshColors(); };
    d.oncontextmenu = (e) => e.preventDefault();
    el.appendChild(d);
  });
}
function refreshColors() {
  $('fgPick').value = rgbaToHex(ui.fg); $('bgPick').value = rgbaToHex(ui.bg);
  $('fgHex').value = rgbaToHex(ui.fg).toUpperCase(); $('fgAlpha').value = ui.fg[3];
  refreshPalette();
}
$('fgPick').addEventListener('input', (e) => { ui.fg = [...hexToRgba(e.target.value).slice(0, 3), ui.fg[3]]; refreshColors(); });
$('bgPick').addEventListener('input', (e) => { ui.bg = hexToRgba(e.target.value); refreshColors(); });
$('fgHex').addEventListener('change', (e) => { if (/^#?[0-9a-f]{6}$/i.test(e.target.value.trim())) ui.fg = [...hexToRgba(e.target.value.trim()).slice(0, 3), ui.fg[3]]; refreshColors(); });
$('fgAlpha').addEventListener('input', (e) => { ui.fg[3] = +e.target.value; });
$('swap').onclick = () => { [ui.fg, ui.bg] = [ui.bg, ui.fg]; refreshColors(); };
$('palAdd').onclick = () => { if (!ui.palette.some((c) => sameColor(c, ui.fg))) ui.palette.push([...ui.fg]); refreshPalette(); changed(); };
$('palDel').onclick = () => { const i = ui.palette.findIndex((c) => sameColor(c, ui.fg)); if (i >= 0) ui.palette.splice(i, 1); refreshPalette(); changed(); };

function refreshTimeline() {
  const t = document.createElement('table');
  const head = document.createElement('tr');
  head.innerHTML = '<th></th><th style="text-align:left;padding:0 6px">Слои</th>';
  doc.frames.forEach((f, i) => {
    const th = document.createElement('th'); th.textContent = i + 1; th.title = `${f.duration} мс`;
    if (i === ui.frame) th.classList.add('cur');
    th.onclick = () => goFrame(i); head.appendChild(th);
  });
  t.appendChild(head);
  for (let li = doc.layers.length - 1; li >= 0; li--) {
    const l = doc.layers[li], tr = document.createElement('tr');
    if (li === ui.layer) tr.classList.add('cur');
    const eye = document.createElement('td'); eye.className = 'eye'; eye.textContent = l.visible ? '👁' : '·'; eye.title = 'Видимость';
    eye.onclick = () => docOp(() => { l.visible = !l.visible; });
    const nm = document.createElement('td'); nm.className = 'lname'; nm.textContent = l.name; nm.title = 'Двойной клик — переименовать';
    nm.onclick = () => { ui.layer = li; refreshTimeline(); };
    nm.ondblclick = () => { const n = prompt('Имя слоя', l.name); if (n) docOp(() => { l.name = n.slice(0, 40); }); };
    tr.append(eye, nm);
    doc.frames.forEach((f, fi) => {
      const td = document.createElement('td'); td.className = 'cel';
      if (fi === ui.frame) td.classList.add(li === ui.layer ? 'cur' : 'curcol');
      td.innerHTML = `<span class="dot ${celEmpty(f.cels[l.id]) ? '' : 'full'}"></span>`;
      td.onclick = () => { ui.layer = li; goFrame(fi); };
      tr.appendChild(td);
    });
    t.appendChild(tr);
  }
  $('tlgrid').replaceChildren(t);
  $('frameDur').value = doc.frames[ui.frame].duration;
  updateStatus();
}
$('frameDur').addEventListener('change', (e) => { const v = clamp(+e.target.value || 100, 10, 10000); docOp(() => { doc.frames[ui.frame].duration = v; }); });
$('showGrid').addEventListener('change', (e) => { ui.grid = e.target.checked; requestRender(); });
$('onion').addEventListener('change', (e) => { ui.onion = e.target.checked; requestRender(); });
$('pivot').addEventListener('change', (e) => { doc.pivot = e.target.value; changed(); });
$('ppu').addEventListener('change', () => changed());
$('brushSize').addEventListener('input', () => requestRender());

function updateStatus() {
  const pen = penInfo && performance.now() - lastPenTime < 2000
    ? ` · перо ${penInfo.eraser ? '(ластик) ' : ''}нажим ${Math.round(penInfo.pressure * 100)}%` : '';
  $('stPos').textContent = (ui.hover ? `${ui.hover.x}, ${ui.hover.y}` : '—') + pen;
  $('stSize').textContent = `${doc.w}×${doc.h}`;
  $('stFrame').textContent = `Кадр ${ui.frame + 1}/${doc.frames.length} · Слой: ${doc.layers[ui.layer]?.name || ''}`;
  $('stZoom').textContent = `${ui.zoom * 100}%`;
}
function refreshAll() { $('pivot').value = doc.pivot; refreshTimeline(); refreshColors(); updateStatus(); requestRender(); }

// ---------------------------------------------------------------- dialogs
function dialog(title, html, onReady) {
  $('dTitle').textContent = title; $('dBody').innerHTML = html; $('modal').hidden = false;
  onReady && onReady($('dBody'));
}
function closeDialog() { $('modal').hidden = true; }
$('dClose').onclick = closeDialog;
$('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) closeDialog(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeDialog(); });

function dlgNew() {
  dialog('Новый спрайт', `
    <div class="row"><label>Имя <input id="nName" value="sprite_${Date.now() % 10000}"></label></div>
    <div class="row"><label>Ширина <input type="number" id="nW" value="32" min="1" max="512"></label>
    <label>Высота <input type="number" id="nH" value="32" min="1" max="512"></label></div>
    <div class="row">${[16, 32, 48, 64, 128].map((s) => `<button data-s="${s}">${s}×${s}</button>`).join('')}</div>
    <div class="row"><button id="nOk">OK</button><button id="nCancel">Отмена</button></div>`, (b) => {
    b.querySelectorAll('[data-s]').forEach((x) => (x.onclick = () => { $('nW').value = $('nH').value = x.dataset.s; }));
    $('nCancel').onclick = closeDialog;
    $('nOk').onclick = () => {
      const name = sanitize($('nName').value);
      resetDoc(clamp(+$('nW').value || 32, 1, 512), clamp(+$('nH').value || 32, 1, 512));
      $('spriteName').value = name; ui.dirty = false; closeDialog(); setSaveState('новый, не сохранён');
    };
  });
}
function dlgResize() {
  dialog('Размер холста', `
    <div class="row"><label>Ширина <input type="number" id="rW" value="${doc.w}" min="1" max="512"></label>
    <label>Высота <input type="number" id="rH" value="${doc.h}" min="1" max="512"></label></div>
    <div class="row"><label>Якорь <select id="rA"><option value="tl">Верх-лево</option><option value="c" selected>Центр</option><option value="b">Низ-центр</option></select></label></div>
    <div class="row"><button id="rOk">OK</button></div>`, () => {
    $('rOk').onclick = () => {
      const nw = clamp(+$('rW').value || doc.w, 1, 512), nh = clamp(+$('rH').value || doc.h, 1, 512), a = $('rA').value;
      const dx = a === 'tl' ? 0 : Math.floor((nw - doc.w) / 2), dy = a === 'tl' ? 0 : a === 'b' ? nh - doc.h : Math.floor((nh - doc.h) / 2);
      docOp(() => {
        for (const f of doc.frames) for (const k of Object.keys(f.cels)) {
          const src = f.cels[k], dst = new ImageData(nw, nh);
          for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
            const tx = x + dx, ty = y + dy; if (tx < 0 || ty < 0 || tx >= nw || ty >= nh) continue;
            dst.data.set(src.data.subarray((y * src.width + x) * 4, (y * src.width + x) * 4 + 4), (ty * nw + tx) * 4);
          }
          f.cels[k] = dst;
        }
        doc.w = nw; doc.h = nh; ui.sel = null; rebuildBuffers();
      });
      fitView(); closeDialog(); requestRender();
    };
  });
}
async function dlgOpen() {
  dialog('Открыть спрайт', '<div class="hint">Загрузка…</div>');
  try {
    const { sprites } = await api('GET', '/api/sprites');
    if (!sprites.length) { $('dBody').innerHTML = '<div class="hint">Спрайтов пока нет. Нарисуйте и нажмите «Сохранить в Unity».</div>'; return; }
    $('dBody').innerHTML = `<div class="hint">Спрайты из папки Unity-проекта. PNG без исходника откроется как один слой.</div><div class="spritelist">${
      sprites.map((s) => `<div class="spritecard" data-n="${s.name}">${s.png ? `<img src="${apiUrl('/api/sprites/' + encodeURIComponent(s.name) + '/png?t=' + s.mtime)}">` : '<img>'}
        <span class="nm">${s.name}</span><span class="tag">${s.project ? 'слои+кадры' : 'только PNG'}</span>
        <button data-del="${s.name}" title="Удалить из Unity">удалить</button></div>`).join('')}</div>`;
    $('dBody').querySelectorAll('.spritecard').forEach((c) => (c.onclick = (e) => {
      if (e.target.dataset.del) return;
      const s = sprites.find((x) => x.name === c.dataset.n); closeDialog(); openSprite(s);
    }));
    $('dBody').querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm(`Удалить «${b.dataset.del}» из Unity-проекта? Это нельзя отменить.`)) return;
      await api('DELETE', '/api/sprites/' + encodeURIComponent(b.dataset.del)); dlgOpen();
    }));
  } catch (err) { $('dBody').innerHTML = `<div class="hint">Сервер недоступен (${err.message}). Запустите start.bat на компьютере с Unity-проектом.</div>`; }
}
async function dlgSettings() {
  let st = {};
  try { st = await api('GET', '/api/status'); } catch { /* server offline */ }
  const cfg = st.config || {};
  dialog('Связь с Unity', `
    ${SAME_ORIGIN ? '' : `<div class="row"><label class="wide">Адрес локального сервера (start.bat)<input id="sServer" class="wide" value="${serverBase()}"></label></div>`}
    <div class="row"><label class="wide">Путь к Unity-проекту<input id="sPath" class="wide" value="${(cfg.unity_project || '').replace(/"/g, '&quot;')}" placeholder="C:\\Users\\...\\MyGame"></label></div>
    <div class="row"><label>Папка в Assets <input id="sFolder" value="${cfg.sprites_folder || 'Sprites/SpriteForge'}"></label>
    <label>PPU по умолчанию <input type="number" id="sPpu" value="${cfg.ppu || 16}"></label></div>
    <div class="hint">Unity: ${st.unity_connected ? 'подключена — ' + (st.unity_name || '') + '<br>' + (st.unity_path || '') : 'не подключена'}<br><br>
    1) Скопируйте папку <b>SpriteForge/unity/Assets/Editor/SpriteForge</b> в Assets/Editor вашего проекта.<br>
    2) Откройте Unity: Window → SpriteForge. Плагин сам сообщит серверу путь к проекту.<br>
    3) Сохранённые спрайты появятся в Assets/${cfg.sprites_folder || 'Sprites/SpriteForge'} с pixel-art настройками и .anim клипом.</div>
    <div class="row"><button id="sOk">Сохранить</button>${st.unity_path ? '<button id="sUse">Взять путь из Unity</button>' : ''}</div>`, () => {
    if ($('sUse')) $('sUse').onclick = () => { $('sPath').value = st.unity_path; };
    $('sOk').onclick = async () => {
      if ($('sServer')) { try { localStorage.setItem('sf.server', $('sServer').value.trim().replace(/\/+$/, '')); } catch { /* storage blocked */ } }
      try {
        const r = await api('POST', '/api/config', { unity_project: $('sPath').value, sprites_folder: $('sFolder').value, ppu: +$('sPpu').value });
        $('ppu').value = r.config.ppu; toast('Настройки сохранены'); closeDialog(); pollStatus();
      } catch (err) { alert(err.message); }
    };
  });
}

// ---------------------------------------------------------------- serialization / sync
function sanitize(n) { return (n || 'untitled').trim().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64) || 'untitled'; }
function imgToDataUrl(img) { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').putImageData(img, 0, 0); return c.toDataURL('image/png'); }
function dataUrlToImg(url, w, h) {
  return new Promise((res, rej) => {
    const im = new Image();
    if (/^https?:/.test(url)) im.crossOrigin = 'anonymous';
    im.onload = () => { const c = document.createElement('canvas'); c.width = w || im.width; c.height = h || im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); res(x.getImageData(0, 0, c.width, c.height)); };
    im.onerror = () => rej(new Error('bad image')); im.src = url;
  });
}
function buildSheet() {
  const c = document.createElement('canvas'); c.width = doc.w * doc.frames.length; c.height = doc.h;
  const x = c.getContext('2d');
  doc.frames.forEach((_, i) => { cctx.clearRect(0, 0, doc.w, doc.h); compose(comp, i); x.drawImage(comp, i * doc.w, 0); });
  return c;
}
function serialize() {
  return {
    format: 'spriteforge', version: 1, w: doc.w, h: doc.h, pivot: doc.pivot, ppu: +$('ppu').value || 16,
    palette: ui.palette.map(rgbaToHex),
    layers: doc.layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible })),
    frames: doc.frames.map((f) => ({ id: f.id, duration: f.duration,
      cels: Object.fromEntries(Object.entries(f.cels).filter(([, v]) => !celEmpty(v)).map(([k, v]) => [k, imgToDataUrl(v)])) })),
  };
}
async function loadProject(p) {
  doc.w = p.w; doc.h = p.h; doc.pivot = p.pivot || 'center';
  doc.layers = p.layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible !== false }));
  doc.frames = [];
  for (const f of p.frames) {
    const cels = {};
    for (const [k, v] of Object.entries(f.cels || {})) cels[k] = await dataUrlToImg(v, p.w, p.h);
    doc.frames.push({ id: f.id, duration: f.duration || 100, cels });
  }
  uid = Math.max(uid, ...doc.layers.map((l) => l.id + 1), ...doc.frames.map((f) => f.id + 1));
  if (p.palette?.length) ui.palette = p.palette.map(hexToRgba);
  if (p.ppu) $('ppu').value = p.ppu;
  ui.frame = 0; ui.layer = doc.layers.length - 1; ui.sel = null; history.undo = []; history.redo = [];
  rebuildBuffers(); fitView(); refreshAll();
}
async function openSprite(s) {
  try {
    if (s.project) await loadProject(await api('GET', '/api/sprites/' + encodeURIComponent(s.name)));
    else {
      const img = await dataUrlToImg(apiUrl(`/api/sprites/${encodeURIComponent(s.name)}/png?t=${Date.now()}`));
      resetDoc(img.width, img.height); doc.frames[0].cels[doc.layers[0].id] = img; refreshAll();
    }
    $('spriteName').value = s.name; ui.dirty = false; setSaveState('открыт из Unity');
    try { localStorage.setItem('sf.last', s.name); } catch { /* storage blocked */ }
  } catch (err) { toast('Не удалось открыть: ' + err.message); }
}
let saving = false, saveAgain = false;
async function saveToUnity(manual) {
  if (saving) { saveAgain = true; return; }
  const name = sanitize($('spriteName').value); $('spriteName').value = name;
  saving = true; setSaveState('сохранение…');
  try {
    const sheet = buildSheet();
    const info = { w: doc.w, h: doc.h, frames: doc.frames.length, durations: doc.frames.map((f) => f.duration), pivot: doc.pivot, ppu: +$('ppu').value || 16 };
    const r = await api('PUT', '/api/sprites/' + encodeURIComponent(name), { project: serialize(), png: sheet.toDataURL('image/png'), info });
    ui.dirty = false; ui.lastSavedRev = r.rev;
    setSaveState('сохранено ' + new Date().toLocaleTimeString());
    if (manual) toast('Сохранено в Unity: ' + r.png_path);
    try { localStorage.setItem('sf.last', name); } catch { /* storage blocked */ }
  } catch (err) {
    setSaveState('не сохранено — сервер offline');
    if (manual) toast(err instanceof TypeError ? 'Нет связи с сервером: запустите start.bat' : 'Ошибка: ' + err.message);
  }
  saving = false;
  if (saveAgain) { saveAgain = false; saveToUnity(false); }
}
let liveTimer = null;
function changed() {
  ui.dirty = true; setSaveState('есть изменения');
  if ($('liveSync').checked) { clearTimeout(liveTimer); liveTimer = setTimeout(() => saveToUnity(false), 700); }
}
function setSaveState(t) { $('saveState').textContent = t; }
function exportPng() {
  const a = document.createElement('a'); a.download = sanitize($('spriteName').value) + '.png';
  a.href = buildSheet().toDataURL('image/png'); a.click();
}
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const url = URL.createObjectURL(file);
  try {
    const img = await dataUrlToImg(url);
    const frames = +prompt('Сколько кадров в этом PNG (горизонтальная полоса)?', '1') || 1;
    const fw = Math.floor(img.width / frames);
    resetDoc(fw, img.height);
    doc.frames = [];
    for (let i = 0; i < frames; i++) {
      const c = new ImageData(fw, img.height);
      for (let y = 0; y < img.height; y++) c.data.set(img.data.subarray((y * img.width + i * fw) * 4, (y * img.width + i * fw + fw) * 4), y * fw * 4);
      doc.frames.push({ id: nid(), duration: 100, cels: { [doc.layers[0].id]: c } });
    }
    $('spriteName').value = sanitize(file.name.replace(/\.png$/i, ''));
    fitView(); refreshAll(); changed();
  } catch (err) { toast('Не удалось загрузить PNG'); }
  URL.revokeObjectURL(url); e.target.value = '';
});

// Served by the local server itself → same origin. Opened from GitHub Pages → talk to the local server.
const SAME_ORIGIN = ['127.0.0.1', 'localhost'].includes(location.hostname);
function serverBase() {
  if (SAME_ORIGIN) return '';
  try { return localStorage.getItem('sf.server') || 'http://127.0.0.1:7777'; } catch { return 'http://127.0.0.1:7777'; }
}
const apiUrl = (url) => serverBase() + url;
async function api(method, url, body) {
  url = apiUrl(url);
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function pollStatus() {
  const el = $('unityState');
  try {
    const s = await api('GET', '/api/status');
    if (s.unity_connected) { el.className = 'pill on'; el.textContent = 'Unity: ' + (s.unity_name || 'подключена'); el.title = s.unity_path; }
    else if (s.unity_project_valid) { el.className = 'pill off'; el.textContent = 'Unity закрыта'; el.title = 'Файлы пишутся в ' + s.config.unity_project + ' — Unity подхватит при открытии'; }
    else { el.className = 'pill off'; el.textContent = 'Unity: не настроена'; el.title = 'Нажмите «Unity…»'; }
  } catch { el.className = 'pill off'; el.textContent = 'Сервер offline'; el.title = 'Запустите start.bat'; }
}
setInterval(pollStatus, 2000);
window.addEventListener('beforeunload', (e) => { if (ui.dirty) { e.preventDefault(); e.returnValue = ''; } });

let toastTimer;
function toast(t) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 2600); }

// ---------------------------------------------------------------- project files (.sforge / .aseprite)
function downloadBlob(filename, blob) {
  const a = document.createElement('a'); a.download = filename; a.href = URL.createObjectURL(blob); a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function dlgExportProject() {
  const name = sanitize($('spriteName').value);
  dialog('Экспорт проекта', `
    <div class="hint">Сохраняется весь проект: слои, кадры, длительности, палитра — его можно открыть и продолжить рисовать.</div>
    <div class="row"><button id="exSforge">${name}.sforge</button><span class="hint">формат SpriteForge — открывается кнопкой «Открыть файл»</span></div>
    <div class="row"><button id="exAse">${name}.aseprite</button><span class="hint">открывается в Aseprite со слоями и анимацией</span></div>`, () => {
    $('exSforge').onclick = () => { downloadBlob(name + '.sforge', new Blob([JSON.stringify(serialize())], { type: 'application/json' })); closeDialog(); };
    $('exAse').onclick = () => { downloadBlob(name + '.aseprite', new Blob([buildAseprite()], { type: 'application/octet-stream' })); closeDialog(); };
  });
}

// Writer for the Aseprite format (https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md).
// RGBA sprite, one normal layer chunk per layer, raw (uncompressed) cels cropped to their content.
function buildAseprite() {
  const out = []; let size = 0;
  function block(n) { const b = new DataView(new ArrayBuffer(n)); out.push(b); size += n; return b; }
  function bytes(u8) { out.push(u8); size += u8.length; }
  const enc = new TextEncoder();
  const chunk = (type, body) => {
    const h = block(6); h.setUint32(0, 6 + body.length, true); h.setUint16(4, type, true); bytes(body);
  };
  const writer = (n) => { const dv = new DataView(new ArrayBuffer(n)); let o = 0;
    return { dv, u8: (v) => { dv.setUint8(o, v); o += 1; }, u16: (v) => { dv.setUint16(o, v, true); o += 2; },
      i16: (v) => { dv.setInt16(o, v, true); o += 2; }, u32: (v) => { dv.setUint32(o, v, true); o += 4; },
      raw: (a) => { new Uint8Array(dv.buffer).set(a, o); o += a.length; }, skip: (k) => { o += k; },
      bytes: () => new Uint8Array(dv.buffer) }; };

  const header = block(128);
  header.setUint16(4, 0xA5E0, true);
  header.setUint16(6, doc.frames.length, true);
  header.setUint16(8, doc.w, true); header.setUint16(10, doc.h, true);
  header.setUint16(12, 32, true);                 // RGBA
  header.setUint32(14, 1, true);                  // layer opacity is valid
  header.setUint16(18, doc.frames[0].duration, true);
  header.setUint16(32, Math.min(ui.palette.length, 65535), true);
  header.setUint8(34, 1); header.setUint8(35, 1); // square pixels
  header.setUint16(40, 16, true); header.setUint16(42, 16, true);

  doc.frames.forEach((f, fi) => {
    const frameStart = size, fh = block(16);
    let chunks = 0;
    if (fi === 0) {
      const pal = ui.palette, pw = writer(20 + pal.length * 6);
      pw.u32(pal.length); pw.u32(0); pw.u32(Math.max(0, pal.length - 1)); pw.skip(8);
      for (const c of pal) { pw.u16(0); pw.u8(c[0]); pw.u8(c[1]); pw.u8(c[2]); pw.u8(c[3]); }
      chunk(0x2019, pw.bytes()); chunks++;
      for (const l of doc.layers) {
        const name = enc.encode(l.name), lw = writer(18 + name.length);
        lw.u16((l.visible ? 1 : 0) | 2); lw.u16(0); lw.u16(0); lw.u16(0); lw.u16(0); lw.u16(0);
        lw.u8(255); lw.skip(3); lw.u16(name.length); lw.raw(name);
        chunk(0x2004, lw.bytes()); chunks++;
      }
    }
    doc.layers.forEach((l, li) => {
      const img = f.cels[l.id]; if (!img || celEmpty(img)) return;
      let x0 = doc.w, y0 = doc.h, x1 = -1, y1 = -1;
      for (let y = 0; y < doc.h; y++) for (let x = 0; x < doc.w; x++) if (img.data[(y * doc.w + x) * 4 + 3]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1, cwr = writer(20 + cw * ch * 4);
      cwr.u16(li); cwr.i16(x0); cwr.i16(y0); cwr.u8(255); cwr.u16(0); cwr.i16(0); cwr.skip(5);
      cwr.u16(cw); cwr.u16(ch);
      for (let y = y0; y <= y1; y++) cwr.raw(img.data.subarray((y * doc.w + x0) * 4, (y * doc.w + x1 + 1) * 4));
      chunk(0x2005, cwr.bytes()); chunks++;
    });
    fh.setUint32(0, size - frameStart, true);
    fh.setUint16(4, 0xF1FA, true);
    fh.setUint16(6, Math.min(chunks, 0xFFFF), true);
    fh.setUint16(8, f.duration, true);
    fh.setUint32(12, chunks, true);
  });
  header.setUint32(0, size, true);
  const result = new Uint8Array(size); let o = 0;
  for (const part of out) { const u8 = part instanceof Uint8Array ? part : new Uint8Array(part.buffer); result.set(u8, o); o += u8.length; }
  return result;
}

// Reader for .aseprite/.ase: RGBA, grayscale and indexed sprites; raw, linked and zlib-compressed cels.
async function parseAseprite(buf) {
  const dv = new DataView(buf), dec = new TextDecoder();
  if (dv.getUint16(4, true) !== 0xA5E0) throw new Error('это не файл Aseprite');
  const nFrames = dv.getUint16(6, true), W = dv.getUint16(8, true), H = dv.getUint16(10, true), depth = dv.getUint16(12, true);
  const transparentIdx = dv.getUint8(28);
  const layers = [], frames = []; let palette = [];
  const inflate = async (u8) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const toRgba = (src, n) => {
    if (depth === 32) return src.subarray(0, n * 4);
    const outp = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      if (depth === 16) { const v = src[i * 2]; outp.set([v, v, v, src[i * 2 + 1]], i * 4); }
      else { const idx = src[i]; const c = palette[idx] || [0, 0, 0, 0]; outp.set(idx === transparentIdx ? [0, 0, 0, 0] : c, i * 4); }
    }
    return outp;
  };
  let pos = 128;
  for (let fi = 0; fi < nFrames; fi++) {
    const fsize = dv.getUint32(pos, true), old = dv.getUint16(pos + 6, true), dur = dv.getUint16(pos + 8, true), nw = dv.getUint32(pos + 12, true);
    const nChunks = nw || old, frame = { duration: dur || 100, cels: {} };
    let cp = pos + 16;
    for (let c = 0; c < nChunks; c++) {
      const csize = dv.getUint32(cp, true), type = dv.getUint16(cp + 4, true), d = cp + 6;
      if (type === 0x2004) {
        const flags = dv.getUint16(d, true), ltype = dv.getUint16(d + 2, true), nlen = dv.getUint16(d + 16, true);
        const name = dec.decode(new Uint8Array(buf, d + 18, nlen));
        layers.push(ltype === 0 ? { name, visible: (flags & 1) !== 0 } : null); // groups/tilemaps are not drawable here
      } else if (type === 0x2019) {
        const first = dv.getUint32(d + 4, true), last = dv.getUint32(d + 8, true); let pp = d + 20;
        for (let i = first; i <= last; i++) {
          const fl = dv.getUint16(pp, true); palette[i] = [dv.getUint8(pp + 2), dv.getUint8(pp + 3), dv.getUint8(pp + 4), dv.getUint8(pp + 5)]; pp += 6;
          if (fl & 1) pp += 2 + dv.getUint16(pp, true);
        }
      } else if (type === 0x2005) {
        const li = dv.getUint16(d, true), cx = dv.getInt16(d + 2, true), cy = dv.getInt16(d + 4, true), op = dv.getUint8(d + 6), ct = dv.getUint16(d + 7, true);
        if (layers[li]) {
          let cw = 0, chh = 0, px = null;
          if (ct === 1) { const linked = frames[dv.getUint16(d + 16, true)]; if (linked?.cels[li]) frame.cels[li] = linked.cels[li]; }
          else if (ct === 0 || ct === 2) {
            cw = dv.getUint16(d + 16, true); chh = dv.getUint16(d + 18, true);
            const data = new Uint8Array(buf, d + 20, csize - 26);
            px = toRgba(ct === 2 ? await inflate(data) : data, cw * chh);
          }
          if (px) {
            const img = new ImageData(W, H);
            for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
              const tx = cx + x, ty = cy + y; if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
              const si = (y * cw + x) * 4, di = (ty * W + tx) * 4;
              img.data[di] = px[si]; img.data[di + 1] = px[si + 1]; img.data[di + 2] = px[si + 2]; img.data[di + 3] = px[si + 3] * op / 255;
            }
            frame.cels[li] = img;
          }
        }
      }
      cp += csize;
    }
    frames.push(frame); pos += fsize;
  }
  return { W, H, layers, frames, palette: palette.filter(Boolean) };
}
async function loadAseprite(buf) {
  const a = await parseAseprite(buf);
  const keep = a.layers.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
  if (!keep.length) throw new Error('в файле нет обычных слоёв');
  doc.w = a.W; doc.h = a.H; doc.pivot = 'center';
  const ids = {}; doc.layers = keep.map((i) => { ids[i] = nid(); return { id: ids[i], name: a.layers[i].name, visible: a.layers[i].visible }; });
  doc.frames = a.frames.map((f) => ({ id: nid(), duration: f.duration,
    cels: Object.fromEntries(keep.filter((i) => f.cels[i]).map((i) => [ids[i], cloneImg(f.cels[i])])) }));
  if (a.palette.length) ui.palette = a.palette.map((c) => [...c]);
  ui.frame = 0; ui.layer = doc.layers.length - 1; ui.sel = null; history.undo = []; history.redo = [];
  rebuildBuffers(); fitView(); refreshAll();
}
$('projectInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  try {
    if (/\.(aseprite|ase)$/i.test(file.name)) await loadAseprite(await file.arrayBuffer());
    else {
      const p = JSON.parse(await file.text());
      if (p.format !== 'spriteforge') throw new Error('это не проект SpriteForge');
      await loadProject(p);
    }
    $('spriteName').value = sanitize(file.name.replace(/\.(sforge|json|aseprite|ase)$/i, ''));
    changed(); toast('Открыт проект: ' + file.name);
  } catch (err) { toast('Не удалось открыть: ' + err.message); }
});

// ---------------------------------------------------------------- boot
buildTools();
resetDoc(32, 32);
previewTick();
$('previewPlay').textContent = '■';
pollStatus();
api('GET', '/api/status').then((s) => { $('ppu').value = s.config?.ppu || 16; }).catch(() => {});
(async () => {
  let last = null; try { last = localStorage.getItem('sf.last'); } catch { /* storage blocked */ }
  if (!last) return;
  try { const { sprites } = await api('GET', '/api/sprites'); const s = sprites.find((x) => x.name === last); if (s) openSprite(s); } catch { /* offline */ }
})();
