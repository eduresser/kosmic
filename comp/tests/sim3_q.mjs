// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };
const desk = { id: "d1" };
const desk2 = { id: "d2" };
const out = { name: 'o1' };
let nid = 0;
function mkWin(cls, minW = 0, minH = 0) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, normalWindow: true, transient: false, dialog: false, specialWindow: false,
    desktops: [desk], output: out, moveable: true, resizeable: true, minimized: false, fullScreen: false, move: false, resize: false,
    maximizeMode: 0, tile: null,
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
  desktops: [desk, desk2], createDesktop(pos, name) { const d = { id: "d" + (ws.desktops.length + 1) }; ws.desktops.splice(pos, 0, d); }, currentDesktop: desk, activeWindow: null, cursorPos: { x: 0, y: 0 },
  get windows() { return wins.slice(); },
  clientArea: () => ({ x: 0, y: 32, width: 1600, height: 968 }),
};
const kw = { MaximizeArea: 1 };
const timers = { restart() {} };
const ui = { activeMode: "", enforceTimer: timers };
const P = await import(process.argv[2]);
P.main({ workspace: ws, kwin: kw }, { root: ui, dbg: () => {} });

function open(cls, minW, minH) {
  const w = mkWin(cls, minW, minH); wins.push(w);
  ws.windowAdded.emit(w);
  ws.activeWindow = w; ws.windowActivated.emit(w);
  return w;
}
function overlap(a, b) { const A = a._g, B = b._g; return Math.min(A.x + A.width, B.x + B.width) - Math.max(A.x, B.x) > 1 && Math.min(A.y + A.height, B.y + B.height) - Math.max(A.y, B.y) > 1; }
function anyOverlap(list) { for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (overlap(list[i], list[j])) return [i, j]; return null; }
const show = (list) => list.map((w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`).join('  ');
const inScreen = (list) => list.forEach((w) => { assert.ok(w._g.x >= 0 && w._g.x + w._g.width <= 1600 && w._g.width >= 150, "window usable and on screen: " + show([w])); });
const settle = (n = 6) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };

const act = (n) => P.action(n);
const a = open('a'), b = open('b'), c = open('c');
console.log('start d1:', show([a, b, c]));
// move c (active) down to d2 (empty desktop, exists)
ws.activeWindow = c; ws.windowActivated.emit(c);
act('workspace-right'); settle();
console.log('after c -> d2: d1:', show([a, b]), '| d2:', show([c]), '| current=', ws.currentDesktop.id, 'active=', ws.activeWindow.resourceClass);
assert.equal(c.desktops[0].id, 'd2'); assert.equal(ws.currentDesktop.id, 'd2'); assert.equal(ws.activeWindow, c);
assert.equal(c._g.width > 1500, true, 'alone on d2 -> fills the desktop');
assert.equal(a._g.height > 900 || b._g.height > 900, true, 'source desktop reflowed');
assert.equal(anyOverlap([a, b]), null);
// c is alone on d2 and d2 is last: workspace-right must do nothing
act('workspace-right'); settle();
assert.equal(c.desktops[0].id, 'd2'); assert.equal(ws.desktops.length, 2);
// open another on d2, then push the second one past the edge: a third desktop is created
const d = open('d'); d.desktops = [desk2]; settle();
ws.activeWindow = d; ws.windowActivated.emit(d);
console.log('d2 with two:', show([c, d]));
act('workspace-right'); settle();
console.log('after d -> new desktop:', ws.desktops.map((x) => x.id).join(','), 'd.desktop=', d.desktops[0].id, 'current=', ws.currentDesktop.id);
assert.equal(ws.desktops.length, 3); assert.equal(d.desktops[0].id, 'd3'); assert.equal(ws.currentDesktop.id, 'd3');
// move up from d3 back onto d2: lands beside c and both are resized
act('workspace-left'); settle();
console.log('after d -> d2:', show([c, d]), 'current=', ws.currentDesktop.id);
assert.equal(d.desktops[0].id, 'd2'); assert.equal(anyOverlap([c, d]), null);
assert.ok(c._g.width < 1000, 'c resized to share d2 with d');
console.log('ALL OK 3');
