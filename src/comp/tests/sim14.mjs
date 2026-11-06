// Live drag preview, as in cosmic-comp: the neighbours open room for the drop, and the preview is
// undone before the drop itself is applied.
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

// Stands in for the dwell timer in main.qml: records what interval was asked for, fires on demand.
const scheduled = [];
ui.dragTimer = { interval: 0, restart() { scheduled.push(this.interval); } };
const fire = () => P.dragCommit();

const g = (w) => w._g;
const snap = () => wins.map((w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`).join(' ');
const geo = (w) => ({ ...w._g });
const same = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const settle = (n = 4) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };
function focus(w) { ws.activeWindow = w; ws.windowActivated.emit(w); return w; }
function open(cls) { const w = mkWin(cls); wins.push(w); ws.windowAdded.emit(w); focus(w); return w; }
const frac = (r, fx, fy) => [r.x + r.width * fx, r.y + r.height * fy];
const step = (w, x, y) => { ws.cursorPos = { x: Math.round(x), y: Math.round(y) }; w.interactiveMoveResizeStepped.emit(); };
function close(w) { wins.splice(wins.indexOf(w), 1); ws.windowRemoved.emit(w); }
// Earlier cases can leave wins[0] or wins[1] stacked, where dragging tears a tab out instead.
function reset(n) {
  for (const w of wins.slice()) close(w);
  const out = [];
  for (let i = 0; i < n; i++) out.push(open('r' + i));
  settle();
  return out;
}

const a = open('a'), b = open('b'), c = open('c');
settle();
const before = new Map(wins.map((w) => [w, geo(w)]));
console.log('inicial:', snap());
assert.ok(wins.length === 3, 'three windows');

focus(c);
c.interactiveMoveResizeStarted.emit();
for (const w of wins) assert.ok(same(g(w), before.get(w)), `${w.resourceClass} must not move when the drag starts`);

// the first zone change waits longer, as COSMIC does
const aBox = before.get(a);
step(c, ...frac(aBox, 0.05, 0.5));
assert.equal(scheduled[scheduled.length - 1], 500, 'the first move out of its own slot waits 500ms');

c._g = { x: 1000, y: 700, width: g(c).width, height: g(c).height };
fire();
console.log('zona aplicada:', snap());
assert.ok(same(g(c), { x: 1000, y: 700, width: before.get(c).width, height: before.get(c).height }),
  'the dragged window belongs to the cursor, not to the layout: ' + snap());
assert.ok(!same(g(a), before.get(a)), 'a opened the space for the drop: ' + snap());
assert.equal(g(a).x > before.get(a).x, true, 'a moved right to make room on its left');

step(c, ...frac(before.get(c), 0.5, 0.5));
assert.equal(scheduled[scheduled.length - 1], 150, 'later zone changes wait 150ms');
fire();
console.log('de volta:', snap());
for (const w of [a, b]) assert.ok(same(g(w), before.get(w)), `${w.resourceClass} went back where it was: ` + snap());

const settledLayout = new Map([a, b].map((w) => [w, geo(w)]));
step(c, ...frac(aBox, 0.05, 0.5));          // scheduled, but the timer is never fired
for (const w of [a, b]) assert.ok(same(g(w), settledLayout.get(w)), `${w.resourceClass} must wait for the dwell: ` + snap());

// --- and letting go applies the drop once, to the tree the drag started from
fire();
const previewLayout = new Map([a, b].map((w) => [w, geo(w)]));
c.interactiveMoveResizeFinished.emit();
settle();
console.log('soltou:', snap());
for (const w of [a, b]) assert.ok(same(g(w), previewLayout.get(w)),
  `${w.resourceClass} ended where the drag had already shown it would: ` + snap());
assert.ok(g(c).x < g(a).x, 'c ended on the left of a, which is where it was dropped: ' + snap());
const overlap = (p, q) => Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x) > 1 &&
                          Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y) > 1;
for (let i = 0; i < wins.length; i++) for (let j = i + 1; j < wins.length; j++) {
  assert.ok(!overlap(g(wins[i]), g(wins[j])), 'no overlap after the drop: ' + snap());
}

const held = new Map([a, b, c].map((w) => [w, geo(w)]));
focus(a);
a.interactiveMoveResizeStarted.emit();
step(a, ...frac(geo(b), 0.05, 0.5));
fire();
assert.ok(!same(g(b), held.get(b)) || !same(g(c), held.get(c)), 'the layout did move for the zone');
const d = open('d');                        // abortLive(): the snapshot no longer describes the tree
a.interactiveMoveResizeFinished.emit();
settle();
console.log('janela nova no meio:', snap());
for (let i = 0; i < wins.length; i++) for (let j = i + 1; j < wins.length; j++) {
  assert.ok(!overlap(g(wins[i]), g(wins[j])), 'no overlap after a window appeared mid-drag: ' + snap());
}

// the dwell keeps the layout still; it must not make a quick drag do nothing
settle();
const quick = new Map(wins.map((w) => [w, geo(w)]));
const victim = wins.find((w) => w !== d);
focus(d);
d.interactiveMoveResizeStarted.emit();
step(d, ...frac(quick.get(victim), 0.5, 0.5));
d.interactiveMoveResizeFinished.emit();            // released without ever firing the timer
settle();
console.log('solto antes do tempo:', snap());
assert.ok(same(g(d), g(victim)), 'released over the middle of a window, it stacked with it: ' + snap());

// A non-tiled window must not cancel the live layout: KWin's drop outline is itself a window, and
// the preview used to cancel itself one step after drawing it.
const [mover, over] = reset(2);
focus(over);
const base = geo(over);
focus(mover);
mover.interactiveMoveResizeStarted.emit();

// Absolute points: an open zone is measured against its group's rect, not the window under the pointer.
const midY = base.y + base.height / 2;
step(mover, 1500, midY);
fire();
assert.ok(g(over).x < base.x, 'room opened on the right, so `over` moved left: ' + snap());

const outline = mkWin('kwin_outline');
outline.normalWindow = false;
wins.push(outline);
ws.windowAdded.emit(outline);
assert.ok(!same(g(outline), base), 'the outline window itself is never tiled');

step(mover, 100, midY);
fire();
console.log('apos janela nao-tilavel:', snap());
assert.ok(g(over).x >= base.x,
  'the layout must still follow the pointer after the outline window appeared -- `over` left where ' +
  'the right-hand zone put it means the drag stopped reading the pointer: ' + snap());

mover.interactiveMoveResizeFinished.emit();
settle();
wins.splice(wins.indexOf(outline), 1);
ws.windowRemoved.emit(outline);
console.log('soltou:', snap());

settle();
const outlines = [];
ws.showOutline = (r) => outlines.push(r);
ws.hideOutline = () => {};
const drag = wins[0], onto = wins[1];
focus(drag);
drag.interactiveMoveResizeStarted.emit();
step(drag, ...frac(geo(onto), 0.05, 0.5));
fire();
const placeholder = outlines[outlines.length - 1];
assert.ok(placeholder, 'a placeholder was drawn');
console.log('placeholder:', JSON.stringify(placeholder));

const held2 = new Map(wins.map((w) => [w, geo(w)]));
const scheduledBefore = scheduled.length;
const drawnBefore = outlines.length;
// An open zone is measured against its group's rect (:3386), which the preview does not move, so a
// still pointer keeps its answer: this is what stops the layout oscillating.
const restingAt = { x: ws.cursorPos.x, y: ws.cursorPos.y };
for (let i = 0; i < 5; i++) {
  ws.cursorPos = { x: restingAt.x, y: restingAt.y };
  drag.interactiveMoveResizeStepped.emit();
}
assert.equal(scheduled.length, scheduledBefore, 'the answer must not change while the pointer does not');
for (const w of wins) assert.ok(same(g(w), held2.get(w)), 'and nothing must move: ' + snap());
assert.equal(outlines.length, drawnBefore, 'and the placeholder must not be redrawn');

drag.interactiveMoveResizeFinished.emit();
settle();
console.log('soltou:', snap());
assert.ok(same(g(drag), placeholder),
  'the window ends exactly where the placeholder was: placeholder=' + JSON.stringify(placeholder) +
  ' window=' + JSON.stringify(geo(drag)));

const shown = [];
ws.showOutline = (r) => shown.push(r);
ws.hideOutline = () => shown.push(null);
settle();
const dragged = wins[0];
focus(dragged);
dragged.interactiveMoveResizeStarted.emit();
const targets = wins.filter((w) => w !== dragged).map(geo);
for (const t of targets) {
  for (const [fx, fy] of [[0.5, 0.5], [0.05, 0.5], [0.5, 0.95], [0.95, 0.5]]) {
    step(dragged, ...frac(t, fx, fy));
    fire();
    assert.ok(shown.length > 0 && shown[shown.length - 1] !== null,
      'the placeholder must never be taken down while the drag is still going');
  }
}
dragged.interactiveMoveResizeFinished.emit();
assert.equal(shown[shown.length - 1], null, 'and must be taken down on release');
settle();

console.log('sim14 ok');
