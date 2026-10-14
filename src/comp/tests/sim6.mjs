// Map of the cases of cosmic-comp's TilingLayout::move_current_node, ported to the fork tree.
import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };
const out = { name: 'o1' };
let dn = 0;
const mkDesk = () => ({ id: 'd' + (++dn) });
const desks = [mkDesk()];
let nid = 0;
function mkWin(cls) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, normalWindow: true, transient: false, dialog: false, specialWindow: false,
    desktops: [ws.currentDesktop], output: out, moveable: true, resizeable: true, minimized: false, fullScreen: false, move: false, resize: false,
    skipPager: false, maximizeMode: 0, tile: null,
    _g: { x: 100, y: 100, width: 500, height: 400 },
    minimizedChanged: sig(), fullScreenChanged: sig(), desktopsChanged: sig(), outputChanged: sig(), frameGeometryChanged: sig(),
    interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(), maximizedChanged: sig(),
    setMaximize(v, h) { w.maximizeMode = (v && h) ? 3 : 0; w.maximizedChanged.emit(); },
  };
  Object.defineProperty(w, 'frameGeometry', {
    get() { return w._g; },
    set(r) { w._g = { x: r.x, y: r.y, width: r.width, height: r.height }; w.frameGeometryChanged.emit(); },
  });
  return w;
}
const wins = [];
const ws = {
  windowAdded: sig(), windowRemoved: sig(), windowActivated: sig(), currentDesktopChanged: sig(),
  desktops: desks, currentDesktop: desks[0], activeWindow: null, cursorPos: { x: 0, y: 0 },
  windowList: () => wins.slice(),
  clientArea: () => ({ x: 0, y: 32, width: 1600, height: 968 }),
  createDesktop(pos) { desks.splice(pos, 0, mkDesk()); },
  removeDesktop(d) { const i = desks.indexOf(d); if (i >= 0) desks.splice(i, 1); },
};
const kw = { MaximizeArea: 1 };
const ui = { activeMode: "", enforceTimer: { restart() {} } };
const P = await import(process.argv[2]);
P.main({ workspace: ws, kwin: kw }, { root: ui, dbg: () => {} });

function open(cls) {
  const w = mkWin(cls); wins.push(w);
  ws.windowAdded.emit(w);
  ws.activeWindow = w; ws.windowActivated.emit(w);
  return w;
}
const focus = (w) => { ws.activeWindow = w; ws.windowActivated.emit(w); };
const show = (...l) => l.map((w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`).join('  ');
// Each case starts on its own workspace so the previous layout cannot leak into it.
function fresh(...names) {
  ws.createDesktop(desks.length);
  ws.currentDesktop = desks[desks.length - 1];
  ws.currentDesktopChanged.emit();
  return names.map(open);
}
const sameRow = (a, b) => Math.round(a._g.y) === Math.round(b._g.y) && Math.round(a._g.height) === Math.round(b._g.height);
const sameCol = (a, b) => Math.round(a._g.x) === Math.round(b._g.x) && Math.round(a._g.width) === Math.round(b._g.width);
const full = (w) => Math.round(w._g.x) === 8 && Math.round(w._g.width) === 1584;

// 1. side by side + up: the fork is split along the other axis, so the window leaves it and takes
//    half of the space the whole group had -- the two end up stacked, the focused one on top.
{
  const [a, b] = fresh('a', 'b');
  assert.ok(sameRow(a, b) && a._g.x < b._g.x, '1 start: ' + show(a, b));
  focus(b);
  P.action('window-up');
  console.log('1 side by side + up:', show(a, b));
  assert.ok(sameCol(a, b) && full(a) && full(b), 'stacked over the full width');
  assert.ok(b._g.y < a._g.y, 'the focused window is on top');
}

// 2. the same the other way round: down puts the focused window at the bottom
{
  const [a, b] = fresh('a', 'b');
  focus(b);
  P.action('window-down');
  console.log('2 side by side + down:', show(a, b));
  assert.ok(sameCol(a, b) && a._g.y < b._g.y, 'the focused window is at the bottom');
}

// 3. stacked + left: the same case on the other axis
{
  const [a, b] = fresh('a', 'b');
  focus(b);
  P.action('window-up');          // stack them, b on top
  P.action('window-left');        // now the fork is vertical and the direction horizontal
  console.log('3 stacked + left:', show(a, b));
  assert.ok(sameRow(a, b) && b._g.x < a._g.x, 'side by side with the focused one on the left');
}

// 4. the fork is split along the direction and the neighbour is a window: they trade places and
//    each keeps the size it had (COSMIC Data::swap_windows)
{
  const [a, b] = fresh('a', 'b');
  focus(a);
  // Resize mode: Meta+R arms it and the arrow keys stop meaning Focus until it is armed off
  // again. They are the same registrations either way -- a chord kglobalaccel has already given
  // out cannot be handed to a second one.
  P.action('resize');
  P.action('focus-right');        // a grows, b shrinks
  P.action('resize');         // and the arrows go back to moving focus
  const wa = Math.round(a._g.width), wb = Math.round(b._g.width);
  assert.notEqual(wa, wb, '4 the split is uneven: ' + show(a, b));
  P.action('window-right');
  console.log('4 swap keeping sizes:', show(a, b));
  assert.ok(b._g.x < a._g.x, 'they traded places');
  assert.equal(Math.round(a._g.width), wa, 'a kept its width');
  assert.equal(Math.round(b._g.width), wb, 'b kept its width');
}

// 5. the neighbour is a group split along the other axis: the window lands in the middle of it
{
  const [a, b] = fresh('a', 'b');
  focus(b);
  const c = open('c');            // c splits b: a | (b over c)
  assert.ok(sameCol(b, c) && b._g.y < c._g.y && a._g.x < b._g.x, '5 start: ' + show(a, b, c));
  focus(a);
  P.action('window-right');
  console.log('5 into a perpendicular group:', show(a, b, c));
  assert.ok(full(a) && full(b) && full(c), 'the three share the full width');
  assert.ok(b._g.y < a._g.y && a._g.y < c._g.y, 'a landed between b and c');
}

// 6. nothing ahead inside the group, and the group above is split along the other axis: the window
//    leaves both and takes a full row
{
  const [a, b] = fresh('a', 'b');
  focus(a);
  const c = open('c');            // c splits a: (a over c) | b
  assert.ok(sameCol(a, c) && a._g.y < c._g.y, '6 start: ' + show(a, c, b));
  focus(c);
  P.action('window-down');
  console.log('6 out of the group and down:', show(a, b, c));
  assert.ok(full(c), 'c took the whole bottom row');
  assert.ok(sameRow(a, b) && a._g.y < c._g.y && b._g.y < c._g.y, 'a and b share the row above');
}

// 7. a row of three. The window climbs out of its group, joins the row, splits the neighbour ahead
//    of it, and only once the two of them are alone in a group does a key swap them. Four presses,
//    not three: on a binary tree the second press already made a and b siblings, but an N-ary group
//    holds all three at once, and move_current_node only trades places when len == 2 (:1611).
{
  const [a, b] = fresh('a', 'b');
  focus(a);
  const c = open('c');            // (a over c) | b
  focus(a);
  P.action('window-right');       // the group runs across the key: a wraps it and steps out beside it
  console.log('7 after the first right:', show(c, a, b));
  assert.ok(sameRow(c, a) && c._g.x < a._g.x && a._g.x < b._g.x, 'c | a | b');
  P.action('window-right');       // nothing to its right inside that group: a climbs and joins the row
  console.log('7 after the second right:', show(c, a, b));
  assert.ok(c._g.x < a._g.x && a._g.x < b._g.x, 'still c | a | b, now all three in one group');
  P.action('window-right');       // three siblings: the neighbour is split and a takes the near half
  console.log('7 after the third right:', show(c, a, b));
  assert.ok(c._g.x < a._g.x && a._g.x < b._g.x, 'order unchanged, but a and b now share a group');
  assert.ok(a._g.width < c._g.width, 'a and b split what was b\'s slot: ' + show(c, a, b));
  P.action('window-right');       // alone with b at last: they trade places and keep their sizes
  console.log('7 after the fourth right:', show(c, b, a));
  assert.ok(b._g.x < a._g.x, 'a moved past b');
}

// 8. at the edge of the tree nothing is left to do: moveInTree gives up and the window changes
//    workspace (up and down have no workspace in that direction, so they stop)
{
  const [a, b] = fresh('a', 'b');
  const desktops = desks.length;
  focus(a);
  P.action('window-up');          // stacked, a on top
  const stacked = show(a, b);
  P.action('window-up');          // a is already at the top
  console.log('8 up at the edge:', show(a, b));
  assert.equal(show(a, b), stacked, 'nothing changed');
  assert.equal(desks.length, desktops, 'no workspace was created');
  P.action('window-left');        // vertical fork, horizontal direction: a takes the left half
  P.action('window-left');        // now a really is at the left edge
  console.log('8 left at the edge: desktops=' + desks.length, show(a, b));
  assert.equal(desks.length, desktops, 'the workspace to the left already existed');
  assert.notEqual(a.desktops[0].id, b.desktops[0].id, 'a left the workspace');
}

console.log('OK sim6');
