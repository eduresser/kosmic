// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// Settings come from kwinrc through KWin.readConfig, not from constants patched into the source at
// build time. Two things have to hold. The gaps and the bar height must actually reach the layout,
// and a kcfg Bool must be read as a boolean: KWin hands one back as the string "false", which is
// truthy, so a bare readConfig result used as a condition turns every switch permanently on.

import assert from 'node:assert';
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
let FAKE_T = 0; Date.now = () => FAKE_T;
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };
const desk = { id: 'd1' };
const out = { name: 'o1' };
let nid = 0;
function mkWin(cls) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, normalWindow: true, transient: false, dialog: false, specialWindow: false,
    desktops: [desk], output: out, moveable: true, resizeable: true, minimized: false, fullScreen: false, move: false, resize: false,
    maximizeMode: 0, tile: null, minSize: { width: 100, height: 80 }, noBorder: false,
    _g: { x: 100, y: 100, width: 500, height: 400 },
    minimizedChanged: sig(), fullScreenChanged: sig(), desktopsChanged: sig(), outputChanged: sig(), frameGeometryChanged: sig(),
    interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(), maximizedChanged: sig(),
  };
  Object.defineProperty(w, 'frameGeometry', {
    get() { return w._g; },
    set(r) { w._g = { x: r.x, y: r.y, width: r.width, height: r.height }; w.frameGeometryChanged.emit(); },
  });
  return w;
}
const wins = [];
const ws = {
  windowAdded: sig(), windowRemoved: sig(), windowActivated: sig(), currentDesktopChanged: sig(),
  currentDesktop: desk, activeWindow: null, cursorPos: { x: 0, y: 0 },
  windowList: () => wins.slice(),
  clientArea: () => ({ x: 0, y: 0, width: 1600, height: 1000 }),
};

// What KWin actually returns: an Int entry comes back as a number, a Bool entry as "true"/"false".
const CONFIG = { GapInner: 40, GapOuter: 20, BarHeight: 60, TabBar: 'false', DropPreview: 'false', Debug: 'false' };
let asked = [];
const kw = {
  MaximizeArea: 1,
  readConfig(key, fallback) { asked.push(key); return key in CONFIG ? CONFIG[key] : fallback; },
};
const timers = { restart() {} };
const bars = [];
const ui = {
  activeMode: "", enforceTimer: timers, dragTimer: timers,
  newBar() { const o = { id: 'bar' + bars.length, visible: false, setModel() {}, place() {} }; bars.push(o); return o; },
};
function mk(cls) { const w = mkWin(cls); wins.push(w); return w; }
const A = mk('A'), B = mk('B');
ws.activeWindow = A;
const P = await import(process.argv[2]);
P.main({ workspace: ws, kwin: kw }, { root: ui, dbg: () => {} });
const settle = (n = 6) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };
const g = (w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`;

settle();
console.log('1 configured gaps:', [A, B].map(g).join('  '));
assert.ok(asked.includes('GapOuter') && asked.includes('TabBar'), 'the script asked kwinrc for its settings');

// GapOuter 20 insets the whole work area and GapInner 40 is the channel between the two windows --
// but an outside edge gets a whole inner gap as well, because a side without a neighbour is given
// `inner` where a side with one is given `inner / 2`. So the edge is 60 and the seam is 40, and
// that is why GapOuter defaults to 0: at 0 the edge and the seam are the same width.
assert.strictEqual(A._g.x, 60, 'outer plus inner on the left edge');
assert.strictEqual(A._g.y, 60, 'outer plus inner on the top edge');
assert.strictEqual(B._g.x + B._g.width, 1540, 'outer plus inner on the right edge');
assert.strictEqual(B._g.x - (A._g.x + A._g.width), 40, 'inner gap between the two');

// TabBar is the string "false". Truthy if used raw, which would take BarHeight off the top of a
// stacked slot; read as a boolean, the stack keeps the whole slot.
const top = A._g.y, height = A._g.height;
ws.activeWindow = A; ws.windowActivated.emit(A);
P.action('stack');
settle();
console.log('2 stacked, tab bar off:', [A, B].map(g).join('  '));
assert.strictEqual(bars.length, 0, 'no tab bar was created');
assert.strictEqual(A._g.y, top, 'the stacked window keeps the top of its slot');
assert.strictEqual(A._g.height, height, 'and the whole height of it: no bar to give 60px to');

console.log('ALL OK 17');
