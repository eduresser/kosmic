// Hysteresis on the drop zones: the zone the pointer is already in is wider than it was to enter,
// so resting near a boundary does not flip the layout back and forth. cosmic-comp does the same
// with its group edges -- a 32px band to enter one, 80px to leave it.
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
    interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(), interactiveMoveResizeStepped: sig(), moveResizedChanged: sig(), maximizedChanged: sig(), captionChanged: sig(),
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

const scheduled = [];
ui.dragTimer = { interval: 0, restart() { scheduled.push(this.interval); } };
const fire = () => P.dragCommit();
const zones = [];
ws.showOutline = (r) => zones.push(r);
ws.hideOutline = () => {};

const g = (w) => w._g;
const geo = (w) => ({ ...w._g });
const show = (l) => l.map((w) => `${w.resourceClass}[${w._g.x},${w._g.y} ${w._g.width}x${w._g.height}]`).join(' ');
const settle = (n = 4) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };
function focus(w) { ws.activeWindow = w; ws.windowActivated.emit(w); return w; }
function open(cls) { const w = mkWin(cls); wins.push(w); ws.windowAdded.emit(w); focus(w); return w; }
const step = (w, r, fx, fy) => {
  ws.cursorPos = { x: Math.round(r.x + r.width * fx), y: Math.round(r.y + r.height * fy) };
  w.interactiveMoveResizeStepped.emit();
};

const a = open('a'), b = open('b');
settle();
const target = geo(a).x < geo(b).x ? b : a;   // whichever sits on the right
const dragged = target === b ? a : b;
const box = geo(target);
console.log('layout:', show([a, b]));

focus(dragged);
dragged.interactiveMoveResizeStarted.emit();

// the middle third of the target stacks
step(dragged, box, 0.40, 0.5);
fire();
let n = scheduled.length;
const stackRect = zones[zones.length - 1];
assert.equal(stackRect.height, box.height - 28, 'the middle third stacks: ' + JSON.stringify(stackRect));

// A committed zone is left alone until the pointer has travelled EDGE_BAND -- 32px, upstream's own
// figure for how far a pointer has to move to mean something. Without it the layout flickers with
// the pointer standing still, because committing a zone changes the rectangle the next one is
// measured against: see previewDrag in kosmic-tiling.mjs.
const at = { x: ws.cursorPos.x, y: ws.cursorPos.y };
const stepAt = (x, y) => { ws.cursorPos = { x: Math.round(x), y: Math.round(y) }; dragged.interactiveMoveResizeStepped.emit(); };

stepAt(at.x + 20, at.y);                       // 20px: not a decision
assert.equal(scheduled.length, n, 'a pointer that has barely moved does not make the layout reconsider');
assert.deepEqual(zones[zones.length - 1], stackRect, 'and the placeholder does not move');

stepAt(at.x, at.y + 31);                       // still inside the band, measured as a distance
assert.equal(scheduled.length, n, 'the band is a radius, not a box');

// Clear of the band, and clear of the middle third of the target -- which is now the whole work
// area, because the target grew into the slot the dragged window gave up. The fractions of the rect
// it had before the drag mean nothing here: zones are read from the live layout.
stepAt(300, at.y);
assert.ok(scheduled.length > n, 'clearly outside, it changes');
fire();
const splitRect = zones[zones.length - 1];
assert.ok(splitRect.height !== stackRect.height || splitRect.width !== stackRect.width,
  'and the placeholder becomes a split: ' + JSON.stringify(splitRect));
assert.ok(splitRect.x < g(target).x, 'on the side the pointer was: ' + JSON.stringify(splitRect));

// and the new zone is just as sticky as the one before it
n = scheduled.length;
stepAt(320, at.y);
assert.equal(scheduled.length, n, 'a hair further along does not flip the side');
assert.deepEqual(zones[zones.length - 1], splitRect, 'and the placeholder stays put');

dragged.interactiveMoveResizeFinished.emit();
settle();
console.log('soltou:', show([a, b]));
assert.ok(!same(g(a), g(b)), 'the two ended up in slots of their own: ' + show([a, b]));

function same(x, y) { return x.x === y.x && x.y === y.y && x.width === y.width && x.height === y.height; }
console.log('sim15 ok');
