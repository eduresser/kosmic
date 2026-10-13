// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// Fractional display scaling: a client is snapped to the device pixel grid, so it never lands
// exactly on the integer rect it was handed (at scale 1.6 a width of 788 comes back as 788.125).
// A window that is already where the layout wants it must not be written to again: every write
// restarts the geometry animation, and a window that did not move must not flicker.
import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };
const desk = { id: 'd1' };
const out = { name: 'o1' };
let nid = 0;
function mkWin(cls, minW = 0, minH = 0) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, caption: cls + ' — title', normalWindow: true, transient: false,
    dialog: false, specialWindow: false, icon: null, noBorder: false, closed: false,
    desktops: [desk], output: out, moveable: true, resizeable: true, minimized: false, fullScreen: false, move: false, resize: false,
    maximizeMode: 0, tile: null, minSize: { width: minW, height: minH },
    _g: { x: 100, y: 100, width: 500, height: 400 },
    minimizedChanged: sig(), fullScreenChanged: sig(), desktopsChanged: sig(), outputChanged: sig(), frameGeometryChanged: sig(),
    interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(), maximizedChanged: sig(), captionChanged: sig(),
    setMaximize(v, h) { w.maximizeMode = (v && h) ? 3 : 0; w.maximizedChanged.emit(); },
    closeWindow() { w.closed = true; },
  };
  Object.defineProperty(w, 'frameGeometry', {
    configurable: true,   // sim11 swaps in a setter that snaps to a fractional scale
    get() { return w._g; },
    set(r) { w._g = { x: r.x, y: r.y, width: Math.max(r.width, minW), height: Math.max(r.height, minH) }; w.frameGeometryChanged.emit(); },
  });
  return w;
}
const wins = [];
const ws = {
  windowAdded: sig(), windowRemoved: sig(), windowActivated: sig(), currentDesktopChanged: sig(),
  currentDesktop: desk, activeWindow: null, cursorPos: { x: 0, y: 0 },
  windowList: () => wins.slice(),
  clientArea: () => ({ x: 0, y: 32, width: 1600, height: 968 }),
};
const kw = { MaximizeArea: 1 };
// Stands in for the PlasmaCore.Dialog the script creates per stack.
const bars = [];
const ui = {
  activeMode: "", enforceTimer: { restart() {} }, osd: () => {},
  newBar() {
    const o = {
      visible: false, destroyed: false, id: -1, rect: null, tabs: [], active: -1,
      apply(id, rect, tabs, active) { o.id = id; o.rect = rect; o.tabs = tabs; o.active = active; o.visible = true; },
      destroy() { o.destroyed = true; },
    };
    bars.push(o);
    return o;
  },
};
const P = await import(process.argv[2]);
P.main({ workspace: ws, kwin: kw }, { root: ui, dbg: () => {} });
ws.desktops = [desk];

const SCALE = 1.6;
const snap = (v) => Math.round(v * SCALE) / SCALE;
const writes = new Map();

// Replaces the plain setter with one that behaves like KWin on a fractionally scaled output, and counts
// how many times each window is actually written to.
function scaled(w) {
  const g0 = w._g;
  Object.defineProperty(w, 'frameGeometry', {
    configurable: true,
    get() { return w._g; },
    set(r) {
      writes.set(w, (writes.get(w) || 0) + 1);
      w._g = { x: snap(r.x), y: snap(r.y), width: snap(r.width), height: snap(r.height) };
      w.frameGeometryChanged.emit();
    },
  });
  w._g = g0;
  return w;
}
const settle = (n = 4) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };
const show = (l) => l.map((w) => `${w.resourceClass}[${w._g.x},${w._g.y} ${w._g.width}x${w._g.height}]`).join(' ');
function focus(w) { ws.activeWindow = w; ws.windowActivated.emit(w); return w; }
function open(cls) { const w = scaled(mkWin(cls)); wins.push(w); ws.windowAdded.emit(w); focus(w); return w; }

const a = open('a'), b = open('b'), c = open('c');
settle();
console.log('layout:', show([a, b, c]));
assert.ok(a._g.width % 1 !== 0 || a._g.height % 1 !== 0 || b._g.width % 1 !== 0,
  'the harness should be producing fractional geometry, got ' + show([a, b, c]));

// idle: nothing moved, so nothing should be written
let base = new Map(writes);
settle(8);
for (const w of [a, b, c]) {
  assert.equal(writes.get(w), base.get(w), `${w.resourceClass} was written to while the layout was idle`);
}

const unchanged = (w, r) => w._g.x === r.x && w._g.y === r.y && w._g.width === r.width && w._g.height === r.height;

// b and c trade places: the whole tree is laid out again, but a keeps the rect it had
base = new Map(writes);
let before = { ...a._g };
focus(b); P.action('swap-down');
settle();
console.log('after swap:', show([a, b, c]));
assert.ok(b._g.y !== before.y || c._g.y !== before.y, 'the swap should have moved something');
assert.ok(unchanged(a, before), 'a should have kept its rect through the swap: ' + show([a]));
assert.equal(writes.get(a), base.get(a), 'a did not move, so it must not have been written to again');

// cycling a stack hands the slot to another window, which lays the tree out again
focus(b); P.action('stack');
settle();
before = { ...a._g };
base = new Map(writes);
P.action('stack-next');
settle();
console.log('after cycle:', show([a, b, c]));
assert.ok(unchanged(a, before), 'a should have kept its rect through the cycle: ' + show([a]));
assert.equal(writes.get(a), base.get(a), 'a is not in the stack and must not be rewritten when a tab changes');

console.log('sim11 ok');
