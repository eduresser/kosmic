import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };
const desk = { id: 'd1' };
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
  currentDesktop: desk, activeWindow: null, cursorPos: { x: 0, y: 0 },
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

const show2 = show;
// 7. window that opens maximized gets unmaximized and tiled
const a = open('a');
const m = mkWin('m'); m.maximizeMode = 3; wins.push(m); ws.windowAdded.emit(m); ws.activeWindow = m; ws.windowActivated.emit(m); settle();
console.log('7 opens maximized:', show([a, m]), 'mode=', m.maximizeMode);
assert.equal(m.maximizeMode, 0); assert.equal(anyOverlap([a, m]), null);
// 8. fullscreen leaves, restores
m.fullScreen = true; m.fullScreenChanged.emit(); settle();
assert.equal(anyOverlap([a]), null);
m.fullScreen = false; m.fullScreenChanged.emit(); settle();
console.log('8 fullscreen back:', show([a, m])); assert.equal(anyOverlap([a, m]), null);
// 9. two windows that both need 1000px on a 1600px screen: must not crash, report overlap state
const x = open('x', 1000, 0), y = open('y', 1000, 0); settle(8);
console.log('9 infeasible:', show([a, m, x, y]));
assert.equal(anyOverlap([a, m, x, y]), null, "stacked instead of overlapping"); inScreen([a, m, x, y]);
// 10. unminimize when sibling vanished
const z = open('z'); settle();
z.minimized = true; z.minimizedChanged.emit(); settle();
for (const w of [x, y]) { wins.splice(wins.indexOf(w), 1); ws.windowRemoved.emit(w); }
z.minimized = false; z.minimizedChanged.emit(); settle();
console.log('10 restore after sibling closed:', show([a, m, z])); assert.equal(anyOverlap([a, m, z]), null);
// 11. window moved to another desktop and back
const d2 = { id: 'd2' }; z.desktops = [d2]; z.desktopsChanged.emit(); settle();
assert.equal(anyOverlap([a, m]), null);
z.desktops = [desk]; z.desktopsChanged.emit(); settle();
console.log('11 desktop roundtrip:', show([a, m, z])); assert.equal(anyOverlap([a, m, z]), null);
console.log('ALL OK 2');
