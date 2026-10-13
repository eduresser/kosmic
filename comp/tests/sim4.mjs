// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

import assert from 'node:assert';
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
let FAKE_T = 0; Date.now = () => FAKE_T;
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };
const desk = { id: 'd1' };
const out = { name: 'o1' };
let nid = 0;
function mkWin(cls, minW = 0, minH = 0) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, normalWindow: true, transient: false, dialog: false, specialWindow: false,
    desktops: [desk], output: out, moveable: true, resizeable: true, minimized: false, fullScreen: false, move: false, resize: false,
    maximizeMode: 0, tile: null, minSize: { width: 182, height: 150 },
    _g: { x: 100, y: 100, width: 500, height: 400 },
    minimizedChanged: sig(), fullScreenChanged: sig(), desktopsChanged: sig(), outputChanged: sig(), frameGeometryChanged: sig(),
    interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(), maximizedChanged: sig(),
    setMaximize(v, h) { w.maximizeMode = (v && h) ? 3 : 0; w.maximizedChanged.emit(); },
  };
  Object.defineProperty(w, 'frameGeometry', {
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
const timers = { restart() {} };
const ui = { activeMode: "", enforceTimer: timers };
function mk(cls) { const w = mkWin(cls); wins.push(w); return w; }
const A = mk('A'), B = mk('B'), C = mk('C');
ws.activeWindow = B;
const P = await import(process.argv[2]);
P.main({ workspace: ws, kwin: kw }, { root: ui, dbg: () => {} });
const g = (w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`;
console.log('after start:', [A, B, C].map(g).join('  '));
for (let i = 0; i < 6; i++) { P.reconcile(); }
console.log('after ticks:', [A, B, C].map(g).join('  '));
const ov = (a, b) => Math.min(a._g.x + a._g.width, b._g.x + b._g.width) - Math.max(a._g.x, b._g.x) > 1 && Math.min(a._g._y ?? a._g.y + a._g.height, b._g.y + b._g.height) - Math.max(a._g.y, b._g.y) > 1;
assert.ok(A._g.width > 700 && B._g.width > 300 && C._g.width > 300, 'every window has a usable width');
assert.ok(A._g.height > 400 && B._g.height > 300 && C._g.height > 300, 'every window has a usable height');
console.log('ALL OK 4');
