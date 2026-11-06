// After every action the slots must tile the work area with no hole or overlap: this catches a `sizes`
// vector drifting from its children, which makes measure() hand rects to the wrong windows.
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
    // floorW models a client with a minimum width that refuses to shrink and lands on its neighbour.
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
  createDesktop(pos) { desks.splice(pos, 0, mkDesk()); },
  removeDesktop(d) { const i = desks.indexOf(d); if (i >= 0) desks.splice(i, 1); },
};
const kw = { MaximizeArea: 1 };
// A stack's tab bar is a QML item, not a window, so it is counted as covering its strip.
const bars = [];
// focusdim dims around the Selection marker, so the asserted rect is the one the effect is handed.
const mark = { shown: false, rect: null };
const modes = [];
const ui = {
  activeMode: "", enforceTimer: { restart() {} }, osd: () => {},
  modeOsd: (m) => { modes.push(m); },
  showSelection(x, y, w, h) { mark.shown = true; mark.rect = { x, y, w, h }; return true; },
  hideSelection() { mark.shown = false; },
  newBar() {
    const o = {
      visible: false, destroyed: false, rect: null,
      apply(id, rect) { o.rect = rect; o.visible = true; },
      destroy() { o.destroyed = true; o.visible = false; },
    };
    bars.push(o);
    return o;
  },
};
const P = await import(process.argv[2]);
P.main({ workspace: ws, kwin: kw }, { root: ui, dbg: () => {} });

const AREA = { x: 0, y: 32, width: 1600, height: 968 };
const INNER = 8;
const g = (w) => w._g;
const show = (l) => l.map((w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`).join(' ');
function focus(w) { ws.activeWindow = w; ws.windowActivated.emit(w); return w; }
function open(cls) { const w = mkWin(cls); wins.push(w); ws.windowAdded.emit(w); focus(w); return w; }
const onDesk = () => wins.filter((w) => w.desktops[0].id === ws.currentDesktop.id);
function close(w) { wins.splice(wins.indexOf(w), 1); ws.windowRemoved.emit(w); }
function reset(n) {
  for (const w of wins.slice()) close(w);
  ws.currentDesktop = desks[0];
  const made = [];
  for (let i = 0; i < n; i++) made.push(open('r' + i));
  settle();
  return made;
}

// Slots are window rects grown by the gap; sampling looks for wallpaper without rebuilding the tree.
function uncovered(list) {
  const rects = list.map((w) => {
    const r = g(w);
    return { x: r.x - INNER, y: r.y - INNER, r2: r.x + r.width + INNER, b2: r.y + r.height + INNER };
  });
  for (const b of bars) {
    if (!b.visible || b.destroyed || !b.rect) continue;
    rects.push({ x: b.rect.x - INNER, y: b.rect.y - INNER,
                 r2: b.rect.x + b.rect.width + INNER, b2: b.rect.y + b.rect.height + INNER });
  }
  for (let x = AREA.x + 4; x < AREA.x + AREA.width; x += 16) {
    for (let y = AREA.y + 4; y < AREA.y + AREA.height; y += 16) {
      let hit = false;
      for (const r of rects) {
        if (x >= r.x && x < r.r2 && y >= r.y && y < r.b2) { hit = true; break; }
      }
      if (!hit) return { x, y };
    }
  }
  return null;
}
// Two windows may share a rect only when they are members of one stack.
function overlapping(list) {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = g(list[i]), b = g(list[j]);
    if (a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height) continue;
    if (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 2 &&
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 2) return [list[i], list[j]];
  }
  return null;
}
// reconcile() runs between keystrokes in a real session and adopts, drops and re-measures on its own.
const settle = (n = 2) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };

function check(where) {
  settle();
  const list = onDesk();
  if (list.length === 0) return;
  const hole = uncovered(list);
  assert.equal(hole, null, `${where}: wallpaper showing through at ${JSON.stringify(hole)} -- ${show(list)}`);
  const pair = overlapping(list);
  assert.equal(pair, null, `${where}: two slots on top of each other -- ${show(list)}`);
  for (const w of list) {
    assert.ok(w._g.width > 0 && w._g.height > 0, `${where}: a window was measured to nothing -- ${show(list)}`);
  }
}

const a = open('a'), b = open('b'), c = open('c'), d = open('d');
check('after opening four');

const DIRS = ['left', 'right', 'up', 'down'];
for (let round = 0; round < 3; round++) {
  for (const w of [a, b, c, d]) {
    for (const dir of DIRS) {
      if (w.desktops[0].id !== ws.currentDesktop.id) continue;
      focus(w);
      P.action('window-' + dir);
      check(`round ${round}: ${w.resourceClass} window-${dir}`);
    }
  }
}
console.log('1 movement:', show(onDesk()));

for (const w of onDesk().slice()) {
  if (w.desktops[0].id !== ws.currentDesktop.id) continue;
  focus(w);
  P.action('focus-out');
  for (const dir of DIRS) {
    if (w.desktops[0].id !== ws.currentDesktop.id) continue;
    P.action('window-' + dir);
    check(`group selected: ${w.resourceClass} window-${dir}`);
  }
}
console.log('2 group moves:', show(onDesk()));

// Focus(Out) repeated reaches the root, which has no parent to move it into.
focus(onDesk()[0]);
for (let i = 0; i < 5; i++) P.action('focus-out');
for (const dir of DIRS) { P.action('window-' + dir); check(`root selected: window-${dir}`); }
console.log('3 root selected:', show(onDesk()));

focus(onDesk()[0]);
for (const act of ['orientation', 'stack', 'window-right', 'orientation', 'window-up',
                   'stack-dissolve', 'window-left', 'orientation', 'window-down']) {
  P.action(act);
  check('mixed: ' + act);
}
console.log('4 mixed:', show(onDesk()));

// Three siblings are needed to reach the split, descend and join arms of move_current_node.
const e = open('e'), f = open('f');
check('after opening six');

const ACTIONS = ['window-left', 'window-right', 'window-up', 'window-down',
                 'swap-window', 'focus-left', 'focus-right', 'focus-up', 'focus-down',
                 'swap-window', 'focus-out', 'focus-in', 'orientation', 'stack', 'stack-dissolve'];
let step = 0;
for (let round = 0; round < 4; round++) {
  for (const w of wins.slice()) {
    if (w.desktops[0].id !== ws.currentDesktop.id) continue;
    focus(w);
    for (const act of ACTIONS) {
      if (w.desktops[0].id !== ws.currentDesktop.id) break;
      P.action(act);
      check(`sweep ${++step}: ${w.resourceClass} ${act}`);
    }
  }
}
console.log('5 sweep:', show(onDesk()));

for (const w of onDesk().slice(0, 3)) {
  focus(w);
  wins.splice(wins.indexOf(w), 1);
  ws.windowRemoved.emit(w);
  check('after closing ' + w.resourceClass);
}
console.log('6 closed:', show(onDesk()));

// A dropped windowRemoved/desktopsChanged leaves a leaf that is measured but never written: a hole.
// Simulated by changing the world without emitting anything.
{
  const list = onDesk();
  const gone = list[0];
  wins.splice(wins.indexOf(gone), 1);
  settle(3);
  check('after a windowRemoved that never arrived');
  assert.ok(!onDesk().includes(gone), 'the window is out of the layout');
}
{
  const list = onDesk();
  assert.ok(list.length >= 2, 'need two windows for this one: ' + show(list));
  const strayed = list[0];
  const other = mkDesk();
  desks.push(other);
  strayed.desktops = [other];
  settle(3);
  check('after a desktopsChanged that never arrived');
  const here = onDesk();
  assert.ok(!here.includes(strayed), 'the strayed window is off this desktop: ' + show(here));
  assert.ok(here.length > 0, 'and the rest of the layout survived');
}
console.log('7 repaired:', show(onDesk()));

// MoveFurther falls back to the neighbouring workspace, which only makes sense for a window; a selected
// group must stay put rather than be scattered across workspaces.
{
  const [p, q] = reset(2);
  focus(p);
  for (let i = 0; i < 5; i++) P.action('focus-out');
  const before = desks.length;
  const home = p.desktops[0].id;
  for (const dir of DIRS) P.action('window-' + dir);
  assert.equal(desks.length, before, 'no workspace was created for a selected group');
  assert.equal(p.desktops[0].id, home, 'the window stayed on its workspace: ' + show(onDesk()));
  assert.equal(q.desktops[0].id, home, 'and so did its neighbour');
  check('group at the root, every direction');
  for (let i = 0; i < 5; i++) P.action('focus-in');
  P.action('window-left');
  assert.ok(desks.length > before || p.desktops[0].id !== home,
    'with a window selected again, left at the edge still crosses: ' + show(onDesk()));
}
console.log('8 group at the root: ok');

// The off half is the one hit by accident, so it has to be undoable.
{
  const [p, q] = reset(2);
  focus(p);
  const tiled = [{ ...g(p) }, { ...g(q) }];
  P.action('tiling');
  settle();
  console.log('9 tiling off:', show(onDesk()));
  P.action('tiling');
  settle();
  console.log('9 tiling on: ', show(onDesk()));
  assert.deepEqual([{ ...g(p) }, { ...g(q) }], tiled,
    'tiling came back on and put the windows where they were: ' + show(onDesk()));
  check('after a tiling round trip');
}
console.log('9 tiling round trip: ok');

// The marker rect is what focusdim measures every window against, so it decides what stays lit.
{
  const [p, q] = reset(2);
  focus(p);
  const slot = { ...g(p) };
  assert.ok(mark.shown, 'the focused window is pointed at');
  // Not grown: a marker reaching half a gap into the neighbour keeps that neighbour undimmed.
  assert.deepEqual(mark.rect, { x: slot.x, y: slot.y, w: slot.width, h: slot.height },
    'flush with the window: ' + JSON.stringify(mark.rect) + ' for ' + JSON.stringify(slot));

  const first = { ...mark.rect };
  focus(q);
  const second = { ...mark.rect };
  assert.ok(second.x > first.x + first.w,
    'two markers do not touch: the gap between the windows is still there: ' +
    JSON.stringify(first) + ' then ' + JSON.stringify(second));

  P.action('focus-out');
  assert.ok(mark.shown, 'the selection is still pointed at');
  assert.deepEqual(mark.rect, { x: first.x, y: first.y, w: second.x + second.w - first.x, h: first.h },
    'the group marker spans both windows exactly: ' + JSON.stringify(mark.rect));
  assert.ok(mark.rect.x >= AREA.x && mark.rect.y >= AREA.y &&
            mark.rect.x + mark.rect.w <= AREA.x + AREA.width &&
            mark.rect.y + mark.rect.h <= AREA.y + AREA.height,
            'and stayed on the screen: ' + JSON.stringify(mark.rect));

  P.action('focus-in');
  assert.deepEqual(mark.rect, second, 'back to the window it came from: ' + JSON.stringify(mark.rect));

  const other = mkDesk();
  desks.push(other);
  q.desktops = [other]; q.desktopsChanged.emit();
  focus(q);
  assert.ok(!mark.shown, 'nothing is pointed at on a desktop that is not showing');
}
console.log('10 active selection: ok');

// Mirrors Shell::resize :4814: the step starts at 10, adds 2 per repeat and caps at 20, so a tap is 12.
{
  const [p, q] = reset(2);
  focus(p);
  P.action('resize');
  const deltas = [];
  let last = g(p).width;
  for (let i = 0; i < 6; i++) {
    FAKE_T += 200;                // upstream repeats a held key on a 200ms timer
    P.action('focus-right');
    deltas.push(g(p).width - last);
    last = g(p).width;
  }
  console.log('11 deltas:', deltas.join(' '));
  assert.deepEqual(deltas, [12, 14, 16, 18, 20, 20],
    'the step accelerates from 12 and stops at 20: ' + deltas.join(' '));

  // KWin does not throttle shortcuts: a held arrow at keyboard rate re-animates on every step and flickers.
  const steady = g(p).width;
  for (let i = 0; i < 5; i++) { FAKE_T += 20; P.action('focus-right'); }
  assert.equal(g(p).width, steady, 'repeats inside 200ms are dropped: ' + show(onDesk()));

  // Down moves nothing here; the key pressed, not its effect, is what resets the acceleration.
  FAKE_T += 200;
  P.action('focus-down');
  const w1 = g(p).width;
  FAKE_T += 200;
  P.action('focus-right');
  assert.equal(g(p).width - w1, 12, 'changing direction starts the acceleration again');

  // Escape cannot be bound globally, so the arming chord exits; presses are spaced so they are not
  // read as keyboard repeats (see the arming-repeat test below).
  FAKE_T += 1000;
  P.action('resize');
  FAKE_T += 1000;
  P.action('resize');
  const w0 = g(p).width;
  FAKE_T += 200;
  P.action('focus-right');
  assert.equal(g(p).width - w0, 12, 'arming the mode again starts over');
  const was = ws.activeWindow;
  FAKE_T += 1000;
  P.action('resize');
  P.action('focus-right');
  assert.notEqual(ws.activeWindow, was, 'with the mode off the arrows go back to moving focus');
  void q;
}
console.log('11 resize acceleration: ok');

// Mirrors SwapWindowGrab (grabs/swap.rs) and keyboard_swap (input/mod.rs :2420): arrows navigate and
// the trade happens on the way out, with whatever is focused then.
{
  const [p, q, r, t] = reset(4);
  const home = new Map(onDesk().map((w) => [w, { ...g(w) }]));
  focus(p);
  P.action('swap-window');
  assert.ok(mark.shown, 'the marked window is pointed at');

  // settle() between keys: a swap spans seconds, and the correction loop must not cancel the mode.
  const path = ['focus-right', 'focus-down', 'focus-right'];
  for (const a of path) { P.action(a); settle(); }
  assert.ok(mark.shown, 'the mode survived the correction loop');
  const landed = ws.activeWindow;
  assert.notEqual(landed, p, 'the focus went somewhere: ' + show(onDesk()));

  const slotP = { ...home.get(p) }, slotL = { ...home.get(landed) };
  P.action('swap-window');
  settle();
  console.log('12 swapped:', show(onDesk()));

  const same = (a, b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 &&
                         Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
  assert.ok(same(g(p), slotL), 'the marked window took the slot the focus ended on: ' + show(onDesk()));
  assert.ok(same(g(landed), slotP), 'and the window there took its place: ' + show(onDesk()));
  assert.equal(ws.activeWindow, p, 'the keyboard stays on the window that was marked');
  check('after a swap');
  void q; void r; void t;
}
console.log('12 swap: ok');

// A client may refuse a size and spill over its neighbour; upstream (tiling/mod.rs :5481) cannot hit this,
// so the marker has to cover where the window went, not only its slot.
{
  const [p, q] = reset(2);
  focus(p);
  const slot = { ...g(p) };
  const overflow = { x: slot.x, y: slot.y, width: slot.width + 220, height: slot.height };
  p.floorW = overflow.width;
  p._g = { x: overflow.x, y: overflow.y, width: overflow.width, height: overflow.height };
  settle();

  assert.ok(mark.shown, 'the window is still pointed at');
  assert.ok(mark.rect.x + mark.rect.w >= overflow.x + overflow.width,
    'the marker reaches the far edge of where the window actually went: ' +
    JSON.stringify(mark.rect) + ' for ' + JSON.stringify(overflow));
  assert.ok(mark.rect.x <= slot.x && mark.rect.y <= slot.y,
    'and still covers the slot it was given: ' + JSON.stringify(mark.rect) +
    ' for ' + JSON.stringify(slot));

  focus(q);
  const slotQ = { ...g(q) };
  assert.deepEqual(mark.rect, { x: slotQ.x, y: slotQ.y, w: slotQ.width, h: slotQ.height },
    'a window that complied is hugged by its slot alone: ' + JSON.stringify(mark.rect));
}
console.log('13 overflow marker: ok');

// cosmic-comp matches Focus bindings without modifiers (grabs/swap.rs :59), but a KWin script only gets
// keys through registerShortcut chords, so the arrows keep their Meta and the mode has to announce it.
{
  const [p] = reset(2);
  focus(p);
  modes.length = 0;
  FAKE_T += 5000;

  P.action('swap-window');
  assert.deepEqual(modes, ['swap'], 'arming the swap says so: ' + JSON.stringify(modes));

  // Spaced so the second press is not swallowed as a keyboard repeat.
  FAKE_T += 1000;
  P.action('swap-window');
  assert.equal(ui.activeMode, '', 'the second press did leave the mode');
  assert.deepEqual(modes, ['swap'], 'leaving it says nothing: ' + JSON.stringify(modes));

  FAKE_T += 1000;
  P.action('resize');
  assert.deepEqual(modes, ['swap', 'resize'], 'and so does the resize: ' + JSON.stringify(modes));
  FAKE_T += 1000;
  P.action('resize');
  assert.equal(ui.activeMode, '', 'and the resize left too');
}
console.log('15 mode osd: ok');

// KWin delivers auto-repeat to global shortcuts (input.cpp :1099), so a held arming chord toggled the mode
// and swapped on every other repeat; repeats are recognised by KWin's default timing (600ms, then 25/s).
{
  const [p, q] = reset(2);
  focus(p);
  modes.length = 0;
  FAKE_T += 5000;                      // clear of whatever the section before left armed

  const home = new Map(onDesk().map((w) => [w, { ...g(w) }]));
  P.action('swap-window');
  assert.deepEqual(modes, ['swap'], 'the press arms the mode');

  FAKE_T += 600;                       // RepeatDelay: the first repeat
  P.action('swap-window');
  for (let i = 0; i < 40; i++) {
    FAKE_T += 40;
    P.action('swap-window');
  }
  assert.deepEqual(modes, ['swap'], 'a held chord arms once and stays armed: ' + JSON.stringify(modes));
  const same = (a, b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 &&
                         Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
  assert.ok(same(g(p), home.get(p)) && same(g(q), home.get(q)),
    'and nothing was swapped while it was held: ' + show(onDesk()));

  // After a swallowed repeat the guard shrinks to one repeat gap, so a deliberate re-press is not delayed.
  FAKE_T += 300;
  P.action('focus-right');             // move the selection, so the trade has somewhere to go
  const landed = ws.activeWindow;
  assert.notEqual(landed, p, 'the arrows still work while the mode is held');

  FAKE_T += 300;
  P.action('swap-window');
  settle();
  assert.ok(same(g(p), home.get(landed)), 'and a deliberate second press trades: ' + show(onDesk()));
  assert.equal(ui.activeMode, '', 'leaving the mode leaves it off');

  // A different chord is a different gesture, even back to back: only one key can be held.
  FAKE_T += 50;
  modes.length = 0;
  P.action('resize');
  assert.deepEqual(modes, ['resize'], 'another chord straight after is not read as a repeat');
  FAKE_T += 5000;
  P.action('resize');
}
console.log('16 arming repeat: ok');

// The kosmic-chordhold plugin sees key releases and drives swap-arm/swap-commit like COSMIC's hold
// (input/mod.rs:2407-2426); both are untimed and idempotent because begin and end may not pair up.
{
  const [p, q] = reset(2);
  focus(p);
  modes.length = 0;
  FAKE_T += 5000;

  const home = new Map(onDesk().map((w) => [w, { ...g(w) }]));
  const same = (a, b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 &&
                         Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;

  P.action('swap-commit');
  assert.equal(ui.activeMode, '', 'committing with nothing armed arms nothing');
  assert.ok(same(g(p), home.get(p)) && same(g(q), home.get(q)),
    'and trades nothing: ' + show(onDesk()));

  // The plugin may begin twice at once; that is not a repeat to swallow.
  P.action('swap-arm');
  P.action('swap-arm');
  assert.equal(ui.activeMode, 'swap', 'the chord going down arms the mode');
  assert.deepEqual(modes, ['swap'], 'and says so once: ' + JSON.stringify(modes));

  P.action('focus-right');
  const landed = ws.activeWindow;
  assert.notEqual(landed, p, 'the arrows still choose while the chord is held');

  // End. No gap: the plugin blocks the key, so there is no repeat to tell a press apart from.
  P.action('swap-commit');
  settle();
  assert.equal(ui.activeMode, '', 'the chord coming up leaves the mode');
  assert.ok(same(g(p), home.get(landed)), 'and trades on the way out: ' + show(onDesk()));
  assert.equal(ws.activeWindow, p, 'the keyboard stays on the window that was marked');
  check('after a held swap');

  const after = new Map(onDesk().map((w) => [w, { ...g(w) }]));
  P.action('swap-commit');
  settle();
  assert.ok(same(g(p), after.get(p)) && same(g(q), after.get(q)),
    'a second end trades nothing: ' + show(onDesk()));
}
console.log('17 held swap: ok');

console.log('sim27 ok');
