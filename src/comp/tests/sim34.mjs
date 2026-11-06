// With one resize chord (COSMIC has two modes) the arrow names the size, not the edge: Right widens,
// Left narrows, Down heightens, Up shortens, wherever the window sits, searching for a seam that gives.
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
    // floorW models a client minimum; the adapter learns it from what the window did and clampSizes reserves it.
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
// Spaced by the 200ms repeat window the mode enforces, since KWin does not throttle shortcuts.
function arrow(dir) { FAKE_T += 200; P.action('focus-' + dir); }
// Spaced so the arming chord is not read as a keyboard repeat.
function arm() { FAKE_T += 1000; P.action('resize'); }
// A client minimum is learned only after a layout was written and not obeyed, so floors need this pass.
const settle = (n = 2) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };

// Regression: the edge-shaped rule inverted the pair for a window after its seam. Doing nothing is allowed
// when there is no seam on the axis; moving the opposite way is not.
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
  assert.ok(alive.length > 30, `1 only ${alive.length} of the presses did anything`);
}
console.log('1 no arrow moves the wrong way: ok');

// The trailing seam is tried first and the leading one after, so a neighbour on its minimum does not
// leave the key dead, as was reported.
{
  // a | (b over (c | d)), the shape a live session was dumped in.
  const [, b] = reset(2);
  focus(b);
  const c = open('c');
  focus(c);
  const d = open('d');
  const a = wins[0];
  assert.ok(g(a).x < g(c).x && g(c).x < g(d).x && g(b).y < g(c).y,
    `2 start is a | (b over (c | d)): ${show()}`);

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

// Unlike the MIN_PANE floor above, this floor is the client's own, learned and reserved by clampSizes.
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

// The column is made by splitting, so the pair starts even and only the arrow moves the seam.
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
  assert.ok(Math.abs(g(a).height - (968 - 16)) < 2, `3 the neighbour column is whole: ${show()}`);
  arm();
}
console.log('3 height on one chord: ok');

// runAction is reached from a shortcut and a throw there kills the script, so unknown handlers are inert.
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

// A toggled resize mode outlives its use, so the next Meta+R disarms it. chordhold/ sees releases and drives
// resize-arm/resize-release, which are untimed and idempotent because the plugin blocks key repeat.
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

  const was = ws.activeWindow;
  P.action('focus-right');
  assert.notEqual(ws.activeWindow, was, '5 the arrows went back to moving focus');
  void q;
}
console.log('5 the resize mode as a hold: ok');

console.log('sim34 ok');
