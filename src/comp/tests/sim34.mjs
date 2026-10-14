// One resize chord, and the arrow names the size rather than the edge.
//
// COSMIC has two modes and the mode says whether the gesture grows or shrinks, so the arrow is free
// to name an edge: Meta+R moves the near one, Meta+Shift+R the far one. With one chord that no
// longer works -- the growing and the shrinking have to come off the same four keys, and reading
// them off which side of the seam the window sits on makes Right widen the leftmost window and
// narrow the rightmost one. So the direction is fixed to the key and the seam is searched: Right
// widens, Left narrows, Down heightens, Up shortens, wherever the window is in the tree.
//
// What this asserts:
//
//   1. the arrow never moves the wrong way, on any window of any layout -- this is the one that
//      fails against the edge-shaped rule, on every window that sits after its seam;
//   2. a seam that refuses is not the end of the gesture: a window whose neighbour is sitting on
//      the minimum and has nothing to give is resized against its other side instead, and a client
//      that will not shrink at all keeps its width while the arrow still lands;
//   3. Up and Down do the same thing to the height from one chord, which is what this was for;
//   4. nothing is bound to the old second chord: the handler is one, not two.
import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };
const out = { name: 'o1' };
const desks = [{ id: 'd1' }];
let nid = 0;
function mkWin(cls) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, normalWindow: true, transient: false, dialog: false, specialWindow: false,
    desktops: [desks[0]], output: out, moveable: true, resizeable: true, minimized: false, fullScreen: false,
    move: false, resize: false, skipPager: false, maximizeMode: 0, tile: null,
    _g: { x: 100, y: 100, width: 500, height: 400 },
    minimizedChanged: sig(), fullScreenChanged: sig(), desktopsChanged: sig(), outputChanged: sig(),
    frameGeometryChanged: sig(), interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(),
    maximizedChanged: sig(),
  };
  Object.defineProperty(w, 'frameGeometry', {
    get() { return w._g; },
    // floorW stands in for a client that will not shrink past a width -- a browser or an editor
    // with a minimum. The adapter learns that figure from what the window actually did, and
    // clampSizes then reserves it on every pass.
    set(r) {
      w._g = { x: r.x, y: r.y, width: Math.max(r.width, w.floorW || 0), height: r.height };
      w.frameGeometryChanged.emit();
    },
  });
  return w;
}
const wins = [];
const ws = {
  windowAdded: sig(), windowRemoved: sig(), windowActivated: sig(), currentDesktopChanged: sig(),
  desktops: desks, currentDesktop: desks[0], activeWindow: null, cursorPos: { x: 0, y: 0 },
  windowList: () => wins.slice(),
  clientArea: () => ({ x: 0, y: 32, width: 1600, height: 968 }),
  createDesktop() {}, removeDesktop() {},
};
const ui = {
  activeMode: "", enforceTimer: { restart() {} }, osd: () => {}, modeOsd: () => {},
  showSelection: () => true, hideSelection: () => {},
  newBar: () => ({ visible: false, apply() {}, destroy() {} }),
};
const P = await import(process.argv[2]);
P.main({ workspace: ws, kwin: { MaximizeArea: 1 } }, { root: ui, dbg: () => {} });

const g = (w) => w._g;
const show = () => wins.map((w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`).join(' ');
function focus(w) { ws.activeWindow = w; ws.windowActivated.emit(w); return w; }
function open(cls) { const w = mkWin(cls); wins.push(w); ws.windowAdded.emit(w); focus(w); return w; }
function reset(n) {
  for (const w of wins.slice()) { wins.splice(wins.indexOf(w), 1); ws.windowRemoved.emit(w); }
  const made = [];
  for (let i = 0; i < n; i++) made.push(open(String.fromCharCode(97 + i)));
  return made;
}
// The arrows are spaced by the repeat window the mode enforces: upstream repeats a held key on a
// 200ms timer and nothing throttles a KWin shortcut, so a step inside that window is dropped.
function arrow(dir) { FAKE_T += 200; P.action('focus-' + dir); }
// And the arming chord is spaced by the one that tells a press from a keyboard repeat.
function arm() { FAKE_T += 1000; P.action('resize'); }
// The audit pass. A client's minimum is learned from what it actually did, which takes a layout
// written and then found not to have been obeyed -- so a floor only becomes real after this runs.
const settle = (n = 2) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };

// ---------- 1. the arrow never moves the wrong way ----------
//
// Every window of every layout, all four arrows, checking the *sign*. A window after its seam has
// no trailing seam to move, so the edge-shaped rule reached for the leading one and inverted the
// pair there -- which is the failure this section exists to keep out. A window with no seam on the
// axis at all is allowed to do nothing; what is not allowed is to do the opposite.
{
  const WANT = { left: ['width', -1], right: ['width', 1], up: ['height', -1], down: ['height', 1] };
  const LAYOUTS = {
    'two across': () => { reset(2); },
    'three across': () => { const [a] = reset(2); focus(a); open('c'); },
    'nested': () => { const [, b] = reset(2); focus(b); open('c'); },
    'deep': () => { const [, b] = reset(2); focus(b); const c = open('c'); focus(c); open('d'); },
  };
  const wrong = [], alive = [];
  for (const [name, build] of Object.entries(LAYOUTS)) {
    FAKE_T += 5000; build(); FAKE_T += 5000;
    for (const w of wins.slice()) {
      for (const dir of Object.keys(WANT)) {
        const [prop, sign] = WANT[dir];
        focus(w);
        arm();
        const before = g(w)[prop];
        arrow(dir);
        const moved = Math.round(g(w)[prop] - before);
        arm();
        if (moved !== 0 && Math.sign(moved) !== sign) {
          wrong.push(`${name} focus=${w.resourceClass} ${dir} moved ${moved}`);
        }
        if (moved !== 0) alive.push(`${name}/${w.resourceClass}/${dir}`);
      }
    }
  }
  assert.deepEqual(wrong, [], '1 an arrow moved the wrong way');
  // And the sweep is not vacuous: most of those presses did something.
  assert.ok(alive.length > 30, `1 only ${alive.length} of the presses did anything`);
}
console.log('1 no arrow moves the wrong way: ok');

// ---------- 2. a seam that refuses is not the end of the gesture ----------
//
// A window only grows by taking from a neighbour, and a neighbour sitting on its minimum has
// nothing to give. The trailing seam is tried first and the leading one after it, so the window
// beside a stubborn client is still resizable from its other side. Without the second attempt the
// key is simply dead -- which is how this was reported.
{
  // a | (b over (c | d)) -- the shape of a real desk, and the one a live session was dumped in.
  // `c` has a seam on both sides: `d` beside it, and `a` at the far left two levels up.
  const [, b] = reset(2);
  focus(b);
  const c = open('c');
  focus(c);
  const d = open('d');
  const a = wins[0];
  assert.ok(g(a).x < g(c).x && g(c).x < g(d).x && g(b).y < g(c).y,
    `2 start is a | (b over (c | d)): ${show()}`);

  // `d` will not give up more than 8px. The trailing seam -- the one the rule prefers -- is the one
  // against `d`, so without a second attempt the arrow dies there. The layout puts `d` back on
  // every pass and `c` never moves, which is precisely how this was reported.
  d.floorW = Math.round(g(d).width) - 8;
  FAKE_T += 5000;
  focus(c);
  arm();
  const aWas = Math.round(g(a).width), cWas = Math.round(g(c).width);
  for (let i = 0; i < 5; i++) arrow('right');
  assert.ok(Math.round(g(c).width) > cWas + 20,
    `2 c kept growing after d ran out: ${show()}`);
  assert.ok(Math.round(g(a).width) < aWas,
    `2 and it was a, on the other side, that paid: ${show()}`);
  arm();
}
console.log('2 a refused seam is retried on the other side: ok');

// ---------- 2b. and the stubborn client keeps its width while the gesture lands ----------
//
// Section 2's floor is the core's own MIN_PANE. This one is the client's -- learned from what the
// window actually did and reserved by clampSizes on every pass, which is a different mechanism and
// a larger figure. What has to hold is that it is honoured and the arrow still works: the window
// that will not shrink does not, and the one being resized grows anyway, from its other side.
{
  const [, b] = reset(2);
  focus(b);
  const c = open('c');
  focus(c);
  const d = open('d');
  const a = wins[0];

  d.floorW = 600;
  d._g = { ...g(d), width: 600 };     // and it has already taken that width rather than its slot
  settle();                           // which is where the adapter learns the figure
  FAKE_T += 5000;
  focus(c);
  assert.ok(Math.round(g(d).width) >= 600, `2b d holds its floor: ${show()}`);
  arm();
  const aWas = Math.round(g(a).width), cWas = Math.round(g(c).width);
  for (let i = 0; i < 5; i++) arrow('right');
  assert.ok(Math.round(g(d).width) >= 600, `2b d never gave up its minimum: ${show()}`);
  assert.ok(Math.round(g(c).width) > cWas, `2b but c still grew: ${show()}`);
  assert.ok(Math.round(g(a).width) < aWas, `2b by taking from a: ${show()}`);
  arm();
}
console.log('2b a client floor is honoured and the arrow still lands: ok');

// ---------- 3. the vertical axis, which is the one this was asked for ----------
//
// Meta+R then Down and Up, with no second chord between them. The column is made the ordinary way
// -- a window opened on top of the focused one splits it -- so the pair starts even and the only
// thing moving the seam is the arrow.
{
  const [a, b] = reset(2);
  focus(b);
  const c = open('c');                // a | (b over c)
  assert.ok(Math.abs(g(b).x - g(c).x) < 2 && g(a).x < g(b).x, `3 start is a | column: ${show()}`);
  const top = g(b).y < g(c).y ? b : c;
  const bottom = top === b ? c : b;
  focus(top);
  arm();
  const start = g(top).height;
  arrow('down');
  const tall = g(top).height;
  assert.ok(tall > start, `3 Down heightens: ${show()}`);
  arrow('up');
  assert.ok(g(top).height < tall, `3 and Up shortens, on the same chord: ${show()}`);
  assert.ok(g(bottom).height > 0, `3 the other half is still there: ${show()}`);
  // The window beside the column is untouched: the seam that moved is the one inside it.
  assert.ok(Math.abs(g(a).height - (968 - 16)) < 2, `3 the neighbour column is whole: ${show()}`);
  arm();
}
console.log('3 height on one chord: ok');

// ---------- 4. there is no second resize handler ----------
//
// The old pair was resize-out and resize-in. An unknown handler has to be inert rather than
// throw -- runAction is reached from a shortcut and a throw there takes the script with it -- so
// this asserts the mode is not armed rather than that the call failed.
{
  reset(2);
  FAKE_T += 5000;
  P.action('resize-in');
  assert.equal(ui.activeMode, '', '4 resize-in is not a handler any more');
  P.action('resize-out');
  assert.equal(ui.activeMode, '', '4 and neither is resize-out');
  arm();
  assert.equal(ui.activeMode, 'resize', '4 the one that is left arms the mode');
  arm();
  assert.equal(ui.activeMode, '', '4 and disarms it');
}
console.log('4 one handler: ok');

// ---------- 5. the mode as a held chord ----------
//
// The toggle is a trap: a resize mode left armed outlives the work that armed it, so the next
// Meta+R disarms when its user means to arm, and the arrows move the focus instead of resizing. A
// state nobody can see, flipped by the only key that reports it, is indistinguishable from a
// broken key.
//
// chordhold/ sees the releases a KWin script never gets and drives these two by name. Both
// halves are idempotent and neither is timed: the toggle needs a repeat guard because auto-repeat
// reaches a global shortcut, and these do not, because the plugin blocks the key before KWin's
// own shortcut handling would repeat it. Arming twice has to be armed, and releasing what was
// never armed has to be nothing.
{
  const [p, q] = reset(2);
  focus(p);
  FAKE_T += 5000;

  P.action('resize-release');
  assert.equal(ui.activeMode, '', '5 releasing what was never armed does nothing');

  P.action('resize-arm');
  assert.equal(ui.activeMode, 'resize', '5 the chord closing arms the mode');
  P.action('resize-arm');
  P.action('resize-arm');
  assert.equal(ui.activeMode, 'resize', '5 and holding it does not toggle back off');

  const before = Math.round(g(p).width);
  arrow('right');
  assert.ok(Math.round(g(p).width) > before, `5 the arrows resize while it is held: ${show()}`);

  P.action('resize-release');
  assert.equal(ui.activeMode, '', '5 the chord opening ends the mode');
  P.action('resize-release');
  assert.equal(ui.activeMode, '', '5 twice is still ended');

  // And with the mode off the arrows are Focus again, which is the whole point of it ending.
  const was = ws.activeWindow;
  P.action('focus-right');
  assert.notEqual(ws.activeWindow, was, '5 the arrows went back to moving focus');
  void q;
}
console.log('5 the resize mode as a hold: ok');

console.log('sim34 ok');
