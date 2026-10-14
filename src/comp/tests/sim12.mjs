// The whole correction loop hangs off the `manual` flag, so a drag whose end never arrives used
// to stop the tiler reconciling anything for the rest of the session. KWin is the authority on
// whether a drag is happening; the flag is only a cache of it, and a stale cache is thrown away.
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
    interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(), moveResizedChanged: sig(), maximizedChanged: sig(), captionChanged: sig(),
    setMaximize(v, h) { w.maximizeMode = (v && h) ? 3 : 0; w.maximizedChanged.emit(); },
    closeWindow() { w.closed = true; },
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

const g = (w) => w._g;
const show = (l) => l.map((w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`).join(' ');
const settle = (n = 4) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };
const same = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
function focus(w) { ws.activeWindow = w; ws.windowActivated.emit(w); return w; }
function open(cls) { const w = mkWin(cls); wins.push(w); ws.windowAdded.emit(w); focus(w); return w; }
const shove = (w, x, y) => { w._g = { x, y, width: w._g.width, height: w._g.height }; w.frameGeometryChanged.emit(); };

const a = open('a'), b = open('b');
settle();
const slotB = { ...g(b) };
assert.ok(!same(g(a), g(b)), 'tiled side by side to begin with');

// 1. a drag that never reports its end must not disable the tiler
b.interactiveMoveResizeStarted.emit();
shove(b, 400, 300);
settle(6);                                  // no interactiveMoveResizeFinished is ever emitted
console.log('1 arrasto sem fim:', show([a, b]));
assert.ok(same(g(b), slotB), 'b should have been put back in its slot: ' + show([b]));

// 2. while KWin really is dragging, the tiler keeps its hands off
b.interactiveMoveResizeStarted.emit();
b.move = true;
shove(b, 400, 300);
settle(6);
console.log('2 arrasto em curso:', show([a, b]));
assert.ok(!same(g(b), slotB), 'a window under the cursor must not be yanked back mid-drag');

// 3. and the end of the drag is honoured through moveResizedChanged alone
b.move = false;
ws.cursorPos = { x: g(a).x + g(a).width / 2, y: g(a).y + g(a).height / 2 };   // dropped on the middle of a
b.moveResizedChanged.emit();
settle();
console.log('3 solto no centro de a:', show([a, b]));
assert.ok(same(g(a), g(b)), 'dropping on the middle should have stacked them: ' + show([a, b]));

console.log('sim12 ok');
