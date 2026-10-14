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

// 1. dwindle + gaps
const a = open('a'), b = open('b'), c = open('c');
console.log('1 dwindle:', show([a, b, c]));
assert.equal(a._g.x, 8); assert.equal(a._g.y, 40);
assert.ok(b._g.x > a._g.x + a._g.width && c._g.y > b._g.y, 'b right of a, c below b');
assert.equal(anyOverlap([a, b, c]), null);

// 2. window that cannot shrink below 1000px wide
const d = open('d', 1000, 0);
settle();
console.log('2 minsize:', show([a, b, c, d]));
assert.equal(anyOverlap([a, b, c, d]), null, 'no overlap with min-size window');
inScreen([a, b, c, d]);

// 3. maximize -> leaves the tree; opening another window restores it
b.maximizeMode = 3; b.maximizedChanged.emit();
settle();
console.log('3 after maximize b:', show([a, c, d]), '| b stays', show([b]));
assert.equal(anyOverlap([a, c, d]), null);
const e = open('e');
settle();
console.log('3 after new window:', show([a, b, c, d, e]), 'b.maximizeMode=', b.maximizeMode);
assert.equal(b.maximizeMode, 0, 'maximized window restored on new focus');
assert.equal(anyOverlap([a, b, c, d, e]), null, 'no overlap after restore');
inScreen([a, b, c, d, e]);

// 4. minimize / restore keeps neighbour
c.minimized = true; c.minimizedChanged.emit();
settle();
assert.equal(anyOverlap([a, b, d, e]), null);
c.minimized = false; c.minimizedChanged.emit();
settle();
console.log('4 restore:', show([a, b, c, d, e]));
assert.equal(anyOverlap([a, b, c, d, e]), null);

// 5. close windows
for (const w of [a, e]) { wins.splice(wins.indexOf(w), 1); ws.windowRemoved.emit(w); }
settle();
console.log('5 closed:', show([b, c, d]));
assert.equal(anyOverlap([b, c, d]), null);

// 6. work area changes (panel grows)
ws.clientArea = () => ({ x: 0, y: 60, width: 1600, height: 940 });
settle();
console.log('6 panel grew:', show([b, c, d]));
assert.ok(b._g.y >= 68 || c._g.y >= 68 || d._g.y >= 68);
assert.equal(anyOverlap([b, c, d]), null);
console.log('ALL OK');
