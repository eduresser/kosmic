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
  desktops: [desk, desk2, { id: "d3" }], createDesktop(pos, name) { const d = { id: "d" + (ws.desktops.length + 1) }; ws.desktops.splice(pos, 0, d); }, currentDesktop: desk, activeWindow: null, cursorPos: { x: 0, y: 0 },
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
const a = open('a'), b = open('b');
settle();
assert.equal(ws.currentDesktop.id, 'd1');

// workspace-last: the final desktop in the list, wherever it is numbered
act('workspace-last'); settle();
assert.equal(ws.currentDesktop.id, ws.desktops[ws.desktops.length - 1].id, 'goes to the last workspace');
const lastId = ws.currentDesktop.id;
act('workspace-last'); settle();
assert.equal(ws.currentDesktop.id, lastId, 'already there: stays');

// workspace-move-last: the active window leaves d1, the rest reflow, and the view follows it
ws.currentDesktop = desk; ws.windowActivated.emit(a); ws.activeWindow = b; ws.windowActivated.emit(b);
act('workspace-move-last'); settle();
assert.equal(b.desktops[0].id, lastId, 'the window is on the last workspace');
assert.equal(ws.currentDesktop.id, lastId, 'the view follows it');
assert.equal(ws.activeWindow, b);
assert.ok(a._g.width > 1500, 'the window left behind fills d1');

// already on the last workspace: nothing to do
const before = JSON.stringify(b._g);
act('workspace-move-last'); settle();
assert.equal(b.desktops[0].id, lastId);
assert.equal(JSON.stringify(b._g), before);
console.log('ALL OK');
