// Dropping a window, by where the pointer is when it is let go. The zones follow cosmic-comp's
// TargetZone: the middle third of a window in both axes stacks, outside it the nearest edge in
// proportion splits, and a drop over no window at all puts the window back where it came from.
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
    set(r) { if (w.stubborn) return; w._g = { x: r.x, y: r.y, width: Math.max(r.width, minW), height: Math.max(r.height, minH) }; w.frameGeometryChanged.emit(); },
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
// Let go of `w` with the pointer at (x, y).
function dropAt(w, x, y) {
  focus(w);
  w.interactiveMoveResizeStarted.emit();
  ws.cursorPos = { x: Math.round(x), y: Math.round(y) };
  w.interactiveMoveResizeFinished.emit();
}
const frac = (r, fx, fy) => [r.x + r.width * fx, r.y + r.height * fy];

const a = open('a'), b = open('b');
settle();
const slotA = { ...g(a) }, slotB = { ...g(b) };

// 1. a client that will not take the rect it is given teaches the layout to stop asking
b.stubborn = true;
shove(b, 400, 300);
settle(6);                       // enforce gives up on b: asking again cannot change its answer
b.stubborn = false;

// 2. ...and that must not outlive the reason for it. Dropped over no window, b goes back to its slot.
dropAt(b, slotB.x + slotB.width / 2, slotB.y + slotB.height / 2);
settle();
console.log('1 solto na propria zona:', show([a, b]));
assert.ok(same(g(b), slotB), 'b should be back in its own slot: ' + show([b]));

// 3. the middle third stacks -- and only the middle third
dropAt(b, ...frac(slotA, 0.5, 0.5));
settle();
console.log('2 centro de a:', show([a, b]));
assert.ok(same(g(a), g(b)), 'the middle of a window stacks with it: ' + show([a, b]));

P.action('stack');               // pull b back out
settle();
assert.ok(!same(g(a), g(b)), 'b is tiled on its own again');

// 30% across is outside the middle third: it splits, where the old half-sized zone would have stacked
const left = g(a).x < g(b).x ? a : b, right = left === a ? b : a;
dropAt(right, ...frac(g(left), 0.3, 0.5));
settle();
console.log('3 a 30% de largura:', show([a, b]));
assert.ok(!same(g(a), g(b)), 'at 30% across the window splits rather than stacking: ' + show([a, b]));

// 4. the split side is the nearest edge in proportion, not in pixels
const tall = { x: 0, y: 0, width: 300, height: 900 };     // 150px to a side, 450px to top or bottom
const side = (r, px, py) => {
  const rx = (px - r.x) / r.width, ry = (py - r.y) / r.height;
  const h = rx < 0.5 ? ['l', rx] : ['r', 1 - rx];
  const v = ry < 0.5 ? ['t', ry] : ['b', 1 - ry];
  return h[1] < v[1] ? h[0] : v[0];
};
assert.equal(side(tall, 20, 60), 't', 'near the top of a tall tile, 20px in: top is nearer in proportion');
assert.equal(side(tall, 20, 450), 'l', 'halfway down a tall tile: the left edge wins');
assert.equal(side(tall, 150, 30), 't', 'centred across, near the top: the top edge wins');


// 5. the outline shown while the drag is still going marks the slot the drop would produce
const outlines = [];
ws.showOutline = (r) => outlines.push(r);
ws.hideOutline = () => outlines.push(null);
const slot = (w) => ({ ...g(w) });
const aSlot = slot(a), bSlot = slot(b);

b.interactiveMoveResizeStarted.emit();
const step = (x, y) => { ws.cursorPos = { x: Math.round(x), y: Math.round(y) }; b.interactiveMoveResizeStepped.emit(); };

step(...frac(aSlot, 0.5, 0.5));                       // middle of a: it would stack
const stacked = outlines[outlines.length - 1];
assert.ok(stacked, 'an outline was drawn');
// The dragged window leaves the tree while it is over a stack, so `a` grows into the space it gave up
// and the placeholder is `a`'s new rect, less the strip the tab bar will take.
assert.equal(stacked.x, g(a).x, 'the placeholder is the target\'s slot: ' + JSON.stringify(stacked));
assert.equal(stacked.width, g(a).width, 'the whole width of it');
assert.equal(stacked.y, g(a).y + 28, 'starting below the tab bar');
assert.equal(stacked.height, g(a).height - 28, 'and the rest of its height');
assert.ok(stacked.width > aSlot.width, 'and the target has grown into the slot the window gave up');

// The zones are read from the layout as it stands, not from a snapshot of it: update_pointer_position
// :3386 resolves the pointer against the live tree, so the fractions below are of the rect `a` has
// NOW -- it has just grown into the slot the dragged window gave up.
const targetNow = { ...g(a) };
const edge = frac(targetNow, 0.02, 0.5);
step(...edge);                                        // left edge of a: it would split
const split = outlines[outlines.length - 1];
assert.notDeepEqual(split, stacked, 'the left edge is not the stack zone: ' + JSON.stringify(split));
assert.ok(split.x < g(a).x, 'a left split lands to the left of the target, which has moved over to make room: ' + JSON.stringify(split) + ' a=' + JSON.stringify(g(a)));
assert.equal(split.height, aSlot.height, 'keeping the full height');

// The pointer has not moved, so neither has the answer. Note it is the *pointer* that must not
// move, not the fraction: once a drop zone is open the walk stops at the group holding it and the
// zone is measured against that group's whole rect (:3386), so the same fraction of a window that
// has just been pushed aside is a different point entirely.
const n = outlines.length;
step(edge[0] + 1, edge[1]);
assert.equal(outlines.length, n, 'the outline is not redrawn while the answer has not changed');

step(...frac(bSlot, 0.5, 0.5));                       // over its own slot: it would stay put
assert.deepEqual(outlines[outlines.length - 1], bSlot, 'over its own slot the outline is its own slot');

b.interactiveMoveResizeFinished.emit();
assert.equal(outlines[outlines.length - 1], null, 'the outline is taken down when the drag ends');

console.log('sim13 ok (com preview)');
