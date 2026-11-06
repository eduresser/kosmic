// Stacking: several windows sharing one slot of the tree, and the tab bar over it.
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

function open(cls, minW, minH) {
  const w = mkWin(cls, minW, minH); wins.push(w);
  ws.windowAdded.emit(w);
  focus(w);
  return w;
}
function focus(w) { ws.activeWindow = w; ws.windowActivated.emit(w); return w; }
function close(w) { wins.splice(wins.indexOf(w), 1); ws.windowRemoved.emit(w); }
// fx, fy: the drop point as a fraction of target's rect.
function dropOn(w, target, fx, fy) {
  const t = g(target);
  ws.cursorPos = { x: Math.round(t.x + t.width * fx), y: Math.round(t.y + t.height * fy) };
  focus(w);
  w.interactiveMoveResizeStarted.emit();
  w.interactiveMoveResizeFinished.emit();
}
const g = (w) => w._g;
const same = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const show = (list) => list.map((w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`).join('  ');
const settle = (n = 6) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };
const BAR = 28;
const FULL = { x: 8, y: 40, width: 1584, height: 952 };
const UNDER_BAR = { x: 8, y: 40 + BAR, width: 1584, height: 952 - BAR };
const liveBar = () => bars.filter((b) => b.visible && !b.destroyed).pop();

// 1. Super+S only makes a stack of one (ToggleStacking :2132); a window joins by moving into it
//    (move_current_node :1570).
const a = open('a'), b = open('b');
assert.ok(!same(g(a), g(b)), 'split before stacking');
focus(a); P.action('stack');
console.log('1 stack of one:', show([a, b]));
assert.ok(a.noBorder, 'a stacked window gives up its decoration');
assert.ok(!same(g(a), g(b)), 'a stack of one keeps its own slot, it does not swallow the neighbour');
assert.equal(g(a).y, FULL.y + BAR, 'and starts below its own bar');

focus(b); P.action('window-left');
console.log('1 joined:', show([a, b]));
assert.ok(same(g(a), UNDER_BAR), 'the stack takes the area below the bar: ' + show([a]));
assert.ok(same(g(b), g(a)), 'both members get the same rect');
assert.equal(ws.activeWindow, a, 'the member in front stays in front; the newcomer joins behind it');
assert.ok(a.noBorder && b.noBorder, 'stacked windows give up their decoration');

const bar = liveBar();
assert.ok(bar, 'a bar was created');
assert.deepEqual(bar.rect, { x: FULL.x, y: FULL.y, width: FULL.width, height: BAR }, 'the bar sits on top of the slot');
assert.equal(bar.tabs.length, 2, 'one tab per member');
assert.equal(bar.tabs[0].title, 'a — title', 'tabs carry the window caption');
assert.equal(bar.active, 0, 'the bar marks the window in front');

P.action('stack-next');
assert.equal(ws.activeWindow, b, 'next member is activated');
assert.ok(same(g(a), UNDER_BAR) && same(g(b), UNDER_BAR), 'geometry does not move while cycling');
assert.equal(liveBar().active, 1, 'the bar follows');
P.action('stack-prev');
assert.equal(ws.activeWindow, a, 'prev goes back');

P.tabActivate(bar.id, 1);
assert.equal(ws.activeWindow, b, 'the tab activated its window');
P.tabActivate(bar.id, 0);
assert.equal(ws.activeWindow, a);

const c = open('c');
settle();
console.log('4 split:', show([a, b, c]));
assert.ok(!same(g(c), g(a)), 'c gets a slot of its own');
assert.ok(same(g(a), g(b)), 'the stack still shares one rect');
assert.equal(g(c).y, FULL.y, 'the unstacked window keeps the whole height');
assert.equal(g(a).y, FULL.y + BAR, 'the stacked ones still start below the bar');
assert.equal(liveBar().rect.width, g(a).width, 'the bar shrank with the slot');

dropOn(c, a, 0.5, 0.5);
settle();
console.log('5 drop centre:', show([a, b, c]));
assert.ok(same(g(c), g(a)) && same(g(b), g(a)), 'three members, one slot');
assert.ok(same(g(c), UNDER_BAR), 'the stack took the whole area back');
assert.equal(liveBar().tabs.length, 3);

focus(c);
P.action('window-up');                  // up never moves inside a stack: it ejects (handle_move :432)
settle();
assert.ok(!same(g(c), g(a)), 'c left the stack');
dropOn(c, a, 0.95, 0.5);
settle();
console.log('6 drop edge:', show([a, b, c]));
assert.ok(!same(g(c), g(a)), 'an edge drop splits instead of stacking');
assert.ok(same(g(a), g(b)), 'a and b are still stacked');

const before = { ...g(a) };
focus(a);
close(a);
settle();
console.log('7 close:', show([b, c]));
// Upstream a stack of one is still a stack (CosmicStack holds a list), so b keeps the slot and the bar.
assert.ok(same(g(b), before), 'b inherits the slot a held, unchanged: ' + show([b]));
assert.ok(b.noBorder, 'and is still a stacked window');
assert.equal(liveBar().tabs.length, 1, 'one tab left');

// 1100: a minimum is only learned from an overflow larger than a client's own rounding slack.
const d = open('d', 1100, 0);
dropOn(d, b, 0.5, 0.5);
settle();
const mate = b;
console.log('8 minsize:', show([b, c, d]));
assert.ok(g(d).width >= 1100, 'the stacked slot keeps the min size of its members: ' + show([d]));
assert.ok(same(g(mate), g(d)), 'both members of the stack share it');

const tabbed = liveBar();
P.tabClose(tabbed.id, tabbed.active === 0 ? 1 : 0);
assert.ok(b.closed || c.closed || d.closed, 'the tab closed its window');

focus(d); P.action('stack-dissolve');
settle();
console.log('10 dissolve:', show([b, c, d]));
assert.ok(!same(g(d), g(mate)), 'no window shares a rect any more');
assert.ok(!d.noBorder && !mate.noBorder, 'decorations are back');
const live = [b, c, d];
for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
  const A = g(live[i]), B = g(live[j]);
  assert.ok(Math.min(A.x + A.width, B.x + B.width) - Math.max(A.x, B.x) <= 1 ||
            Math.min(A.y + A.height, B.y + B.height) - Math.max(A.y, B.y) <= 1,
            'no overlap after dissolve: ' + show(live));
}

console.log('sim9 ok');
