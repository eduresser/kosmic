// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// The layout always covers the work area, after every action.
//
// A tiling layout has one property that holds no matter what was pressed: the slots tile the work
// area. No hole, no overlap. Every other sim checks the outcome of one gesture it already has an
// opinion about; this one presses keys and checks that invariant after each, which is the only
// thing that catches a tree whose `sizes` vector has drifted from its children -- measure() pushes
// one rect per size and pops one per child, so a group holding three children and two sizes hands
// out a rect meant for someone else and everything after it is misaligned. On the screen that is a
// rectangle of wallpaper in the middle of the layout.
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
    // floorW stands in for a client that will not shrink past a width -- a browser with a minimum,
    // which is the case that puts a window on top of its neighbour. Unset for every other window
    // here, so the setter is the plain one it was.
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
// A stack gives the top of its slot to the tab bar, which is a QML item and not a window, so the
// strip is covered without anything being written there. Stands in for it well enough to be counted.
const bars = [];
// Stands in for the Selection marker main.qml creates. It draws nothing on a real screen -- the
// focusdim effect dims around it -- so what is asserted here is the rect the effect is handed.
const mark = { shown: false, rect: null };
// Which modes announced themselves. A mode that says nothing on the screen silently changes what
// the next key does, and here it also has to say that the arrows still need their Meta.
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
// Start a section from a known layout rather than from whatever the one before it left behind.
function reset(n) {
  for (const w of wins.slice()) close(w);
  ws.currentDesktop = desks[0];
  const made = [];
  for (let i = 0; i < n; i++) made.push(open('r' + i));
  settle();
  return made;
}

// Every slot is its window's rect grown by the gap, so the slots tile the area exactly. Sampling
// asks the question the eye asks -- is there wallpaper showing through -- without having to
// reconstruct the tree from outside the module.
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
// The periodic loop runs between every pair of keystrokes in a real session, and it is the half of
// the module that adopts, drops and re-measures behind the user's back. A sweep that never lets it
// run is testing half the code.
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

// ---------- 1. plain movement, every direction, from every window ----------
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

// ---------- 2. the same, with a group selected ----------
//
// Focus(Out) selects the group around the focused window, and Move then applies to the whole group.
// Nothing on the screen says the selection changed -- the selection marker does not exist yet -- so a
// user who presses Meta+U and then an arrow is pressing what looks like an ordinary move.
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

// ---------- 3. climbing out of the tree entirely ----------
// Focus(Out) repeated reaches the root, which has no parent to move it into.
focus(onDesk()[0]);
for (let i = 0; i < 5; i++) P.action('focus-out');
for (const dir of DIRS) { P.action('window-' + dir); check(`root selected: window-${dir}`); }
console.log('3 root selected:', show(onDesk()));

// ---------- 4. mixed with the other node actions ----------
focus(onDesk()[0]);
for (const act of ['orientation', 'stack', 'window-right', 'orientation', 'window-up',
                   'stack-dissolve', 'window-left', 'orientation', 'window-down']) {
  P.action(act);
  check('mixed: ' + act);
}
console.log('4 mixed:', show(onDesk()));

// ---------- 5. a bigger layout, and the actions that reshape it ----------
//
// Five and six windows is where the user's report came from, and it is also where an N-ary group
// first holds more children than a binary fork could: the arms of move_current_node that split a
// neighbour, descend into a group, or join a stack all need three siblings to be reachable at all.
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

// ---------- 6. closing windows out of whatever that left ----------
for (const w of onDesk().slice(0, 3)) {
  focus(w);
  wins.splice(wins.indexOf(w), 1);
  ws.windowRemoved.emit(w);
  check('after closing ' + w.resourceClass);
}
console.log('6 closed:', show(onDesk()));

// ---------- 7. a signal that never arrived ----------
//
// Everything above assumes KWin tells the truth: a window that goes away emits windowRemoved, a
// window that changes desktop emits desktopsChanged. When one of those does not arrive -- and the
// whole `manual` constraint exists because one of them already did not -- the tree
// keeps a leaf naming a window that is not there. That leaf is measured and never written into,
// and on the screen it is a rectangle of wallpaper in the middle of the layout.
//
// Both are simulated by changing the world without emitting anything, which is precisely what a
// dropped signal is.
{
  const list = onDesk();
  const gone = list[0];
  wins.splice(wins.indexOf(gone), 1);          // closed, and KWin said nothing
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
  strayed.desktops = [other];                  // moved, and KWin said nothing
  settle(3);
  check('after a desktopsChanged that never arrived');
  const here = onDesk();
  assert.ok(!here.includes(strayed), 'the strayed window is off this desktop: ' + show(here));
  assert.ok(here.length > 0, 'and the rest of the layout survived');
}
console.log('7 repaired:', show(onDesk()));

// ---------- 8. a selected group is not a window ----------
//
// Focus(Out) selects the group around the focused window, and Move then applies to the group. When
// the group has nowhere left to go, move_current_node answers MoveFurther -- which upstream hands
// to the next output. KOSMIC has no per-output workspaces, so the fallback is the neighbouring
// workspace, and that only makes sense for a window: handing one window of a selected group to
// another workspace is not the move that was asked for, and pressing it a few times scatters the
// layout across workspaces with nothing on screen explaining why. Super+U is invisible until the
// selection marker exists, so this reads as "the arrow keys started throwing windows away".
{
  const [p, q] = reset(2);
  focus(p);
  for (let i = 0; i < 5; i++) P.action('focus-out');   // climb to the root
  const before = desks.length;
  const home = p.desktops[0].id;
  for (const dir of DIRS) P.action('window-' + dir);
  assert.equal(desks.length, before, 'no workspace was created for a selected group');
  assert.equal(p.desktops[0].id, home, 'the window stayed on its workspace: ' + show(onDesk()));
  assert.equal(q.desktops[0].id, home, 'and so did its neighbour');
  check('group at the root, every direction');
  // Focus(In) walks back down, and then the window travels as it always did.
  for (let i = 0; i < 5; i++) P.action('focus-in');
  P.action('window-left');
  assert.ok(desks.length > before || p.desktops[0].id !== home,
    'with a window selected again, left at the edge still crosses: ' + show(onDesk()));
}
console.log('8 group at the root: ok');

// ---------- 9. toggling tiling is a toggle ----------
//
// Meta+Y off and Meta+Y on. The off half is the one that gets exercised by accident, and a module
// that cannot undo it leaves the user with a workspace that silently stopped tiling and no way back.
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

// ---------- 10. the marker says what is selected ----------
//
// The whole reason Focus(Out) was dangerous: it changes what the next key means and, until this,
// said nothing. What is asserted is the rect handed to the marker, which is the rect the focusdim
// effect measures every window against -- so these are the numbers that decide what stays lit.
{
  const [p, q] = reset(2);
  focus(p);
  const slot = { ...g(p) };
  assert.ok(mark.shown, 'the focused window is pointed at');
  // The slot exactly, with nothing added. The outline this replaced was grown by the width of its
  // pen so the line landed just outside the window; a marker grown that way reaches half an inner
  // gap into the neighbouring slot, which is enough of a neighbour to keep it undimmed.
  assert.deepEqual(mark.rect, { x: slot.x, y: slot.y, w: slot.width, h: slot.height },
    'flush with the window: ' + JSON.stringify(mark.rect) + ' for ' + JSON.stringify(slot));

  const first = { ...mark.rect };
  focus(q);
  const second = { ...mark.rect };
  assert.ok(second.x > first.x + first.w,
    'two markers do not touch: the gap between the windows is still there: ' +
    JSON.stringify(first) + ' then ' + JSON.stringify(second));

  // Focus(Out) grows it to the group, which is the whole point of the key.
  P.action('focus-out');
  assert.ok(mark.shown, 'the selection is still pointed at');
  assert.deepEqual(mark.rect, { x: first.x, y: first.y, w: second.x + second.w - first.x, h: first.h },
    'the group marker spans both windows exactly: ' + JSON.stringify(mark.rect));
  assert.ok(mark.rect.x >= AREA.x && mark.rect.y >= AREA.y &&
            mark.rect.x + mark.rect.w <= AREA.x + AREA.width &&
            mark.rect.y + mark.rect.h <= AREA.y + AREA.height,
            'and stayed on the screen: ' + JSON.stringify(mark.rect));

  // Focus(In) walks it back down to the window.
  P.action('focus-in');
  assert.deepEqual(mark.rect, second, 'back to the window it came from: ' + JSON.stringify(mark.rect));

  // A window that is not on this desktop is not pointed at.
  const other = mkDesk();
  desks.push(other);
  q.desktops = [other]; q.desktopsChanged.emit();
  focus(q);
  assert.ok(!mark.shown, 'nothing is pointed at on a desktop that is not showing');
}
console.log('10 active selection: ok');

// ---------- 11. the resize step accelerates, as upstream's does ----------
//
// Shell::resize :4814 keeps the amount in `resize_state`: it starts at 10, adds 2 on every repeat
// and stops at 20, and finish_resize clears it when the key comes up. A tap is 12 and holding the
// key walks up to 20. This was 64 here, invented, until the number was read off the source.
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

  // Faster than that and the repeats are dropped. Nothing throttles a KWin shortcut: a held arrow
  // arrives at the keyboard's own rate, five or six times upstream's, and every one of them writes
  // geometry and starts the animation again -- which is what reads as the screen flickering.
  const steady = g(p).width;
  for (let i = 0; i < 5; i++) { FAKE_T += 20; P.action('focus-right'); }
  assert.equal(g(p).width, steady, 'repeats inside 200ms are dropped: ' + show(onDesk()));

  // A different direction is a different gesture, and starts over. Down does nothing at all here
  // -- two windows side by side have no horizontal seam to move -- which is exactly the point:
  // what resets the acceleration is the key that was pressed, not whether it achieved anything.
  FAKE_T += 200;
  P.action('focus-down');
  const w1 = g(p).width;
  FAKE_T += 200;
  P.action('focus-right');
  assert.equal(g(p).width - w1, 12, 'changing direction starts the acceleration again');

  // And so does leaving the mode and arming it again. The arming chord is the way out: Escape
  // cannot be bound globally without taking it from the rest of the desktop.
  //
  // The presses are spaced out because the arming chord tells a press from a keyboard repeat by its
  // timing -- see section 16. Two of them at the same instant, which is what this used to do, is
  // precisely what a repeat looks like and is not something a hand can produce.
  FAKE_T += 1000;
  P.action('resize');
  FAKE_T += 1000;
  P.action('resize');
  const w0 = g(p).width;
  FAKE_T += 200;
  P.action('focus-right');
  assert.equal(g(p).width - w0, 12, 'arming the mode again starts over');
  // Armed, the arrows are not Focus. Disarmed, they are again.
  const was = ws.activeWindow;
  FAKE_T += 1000;
  P.action('resize');
  P.action('focus-right');
  assert.notEqual(ws.activeWindow, was, 'with the mode off the arrows go back to moving focus');
  void q;
}
console.log('11 resize acceleration: ok');

// ---------- 12. swap marks a window and trades it with wherever the focus ends up ----------
//
// SwapWindowGrab (grabs/swap.rs) dispatches the user's own Focus bindings while it holds the
// keyboard, and keyboard_swap (input/mod.rs :2420) runs on release -- between the node that was
// marked and whatever is focused by then. So the arrows navigate, and the trade happens on the way
// out. Swapping with the geometric neighbour on every arrow, which is what this did first, can
// only ever trade the same two back and forth.
{
  const [p, q, r, t] = reset(4);
  const home = new Map(onDesk().map((w) => [w, { ...g(w) }]));
  focus(p);
  P.action('swap-window');          // mark p
  assert.ok(mark.shown, 'the marked window is pointed at');

  // Navigate. Each arrow is an ordinary focus move while the mode holds the keys.
  // With the correction loop running in between, which is where a mode that something else
  // quietly cancels would show up: a swap takes several keystrokes and seconds of real time.
  const path = ['focus-right', 'focus-down', 'focus-right'];
  for (const a of path) { P.action(a); settle(); }
  assert.ok(mark.shown, 'the mode survived the correction loop');
  const landed = ws.activeWindow;
  assert.notEqual(landed, p, 'the focus went somewhere: ' + show(onDesk()));

  const slotP = { ...home.get(p) }, slotL = { ...home.get(landed) };
  P.action('swap-window');          // and trade
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


// ---------- 13. a window that spills out of its slot is still inside the marker ----------
//
// A KWin client can refuse a size, and one that refuses is drawn outside the slot it was given --
// over its neighbour, which is how it was reported. Upstream draws the indicator on the node's rect
// straight off the tree (tiling/mod.rs :5481) and cannot hit this, because a cosmic-comp client is
// whatever size the compositor says. Here the slot alone puts a line down the middle of a window.
{
  const [p, q] = reset(2);
  focus(p);
  const slot = { ...g(p) };
  const overflow = { x: slot.x, y: slot.y, width: slot.width + 220, height: slot.height };
  p.floorW = overflow.width;   // it will not shrink past this, whatever it is handed
  p._g = { x: overflow.x, y: overflow.y, width: overflow.width, height: overflow.height };
  settle();

  assert.ok(mark.shown, 'the window is still pointed at');
  assert.ok(mark.rect.x + mark.rect.w >= overflow.x + overflow.width,
    'the marker reaches the far edge of where the window actually went: ' +
    JSON.stringify(mark.rect) + ' for ' + JSON.stringify(overflow));
  assert.ok(mark.rect.x <= slot.x && mark.rect.y <= slot.y,
    'and still covers the slot it was given: ' + JSON.stringify(mark.rect) +
    ' for ' + JSON.stringify(slot));

  // And a window sitting where it was put gets the slot exactly, which is every ordinary case.
  focus(q);
  const slotQ = { ...g(q) };
  assert.deepEqual(mark.rect, { x: slotQ.x, y: slotQ.y, w: slotQ.width, h: slotQ.height },
    'a window that complied is hugged by its slot alone: ' + JSON.stringify(mark.rect));
}
console.log('13 overflow marker: ok');

// ---------- 15. a mode says which keys it took ----------
//
// It has to, because the keys are not upstream's. cosmic-comp's SwapWindowGrab holds the seat's
// keyboard and matches a Focus binding on its key alone, modifiers discarded
// (tiling/grabs/swap.rs :59), so a bare arrow moves the selection there. A KWin script gets no key
// except through registerShortcut, which needs a chord -- measured, not assumed: a window of the
// script's own reaches full QML focus and still receives nothing, and the scripted effects API has
// no keyboard call. So the arrows keep their Meta and the mode has to say so.
{
  const [p] = reset(2);
  focus(p);
  modes.length = 0;
  FAKE_T += 5000;

  P.action('swap-window');
  assert.deepEqual(modes, ['swap'], 'arming the swap says so: ' + JSON.stringify(modes));

  // Spaced, because the arming chord reads two presses at the same instant as a keyboard repeat
  // and swallows the second -- see section 16. Without the gap this assertion would hold because
  // the mode never left, which is the same words for the opposite fact.
  FAKE_T += 1000;
  P.action('swap-window');          // and back out
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


// ---------- 16. holding the arming chord arms once ----------
//
// Keyboard auto-repeat reaches a global shortcut: KWin's GlobalShortcutFilter passes
// KeyboardKeyState::Repeated to processKey exactly as it passes Pressed (input.cpp :1099), because
// that is what makes a held arrow repeat a resize. The arming chord is delivered the same way, so a
// held Meta+X toggled the mode at the keyboard's rate -- and since leaving the swap mode *is* the
// trade, every other repeat ran doSwap. Reported as "it flickers between modes"; it was also
// swapping the window back and forth twelve times a second.
//
// Upstream cannot reach this: there the mode is the hold itself. The repeat is recognised here by
// its timing, against KWin's own defaults -- 600ms to the first repeat, then 25 a second.
{
  const [p, q] = reset(2);
  focus(p);
  modes.length = 0;
  FAKE_T += 5000;                      // clear of whatever the section before left armed

  const home = new Map(onDesk().map((w) => [w, { ...g(w) }]));
  P.action('swap-window');             // the press
  assert.deepEqual(modes, ['swap'], 'the press arms the mode');

  FAKE_T += 600;                       // RepeatDelay: the first repeat
  P.action('swap-window');
  for (let i = 0; i < 40; i++) {       // and 40 more at the repeat rate
    FAKE_T += 40;
    P.action('swap-window');
  }
  assert.deepEqual(modes, ['swap'], 'a held chord arms once and stays armed: ' + JSON.stringify(modes));
  const same = (a, b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 &&
                         Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
  assert.ok(same(g(p), home.get(p)) && same(g(q), home.get(q)),
    'and nothing was swapped while it was held: ' + show(onDesk()));

  // The key comes up and the chain stops. One repeat gap later the chord is a press again, which
  // is the whole point of shortening the window after a swallowed repeat: waiting a repeat *delay*
  // after letting go would be felt.
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


// ---------- 17. the swap as a held chord, driven from outside ----------
//
// What programs.kosmic.chordHold buys. COSMIC's swap is a hold: the mode ends the instant a
// modifier of the binding or its key goes up, and keyboard_swap runs on that same release
// (input/mod.rs:2407-2426). A KWin script is never told a key came up, so the chord here is a
// toggle -- unless something that does see releases calls in, which is what the InputActions
// plugin does through two Plasma shortcut names.
//
// Both halves are idempotent and neither is timed. That is the point: the toggle needs a repeat
// guard because auto-repeat reaches a global shortcut, and these two do not, because the plugin
// blocks the key before KWin sees it. Begin and end also are not guaranteed to pair up, so
// arming twice has to be armed and committing nothing has to be nothing.
{
  const [p, q] = reset(2);
  focus(p);
  modes.length = 0;
  FAKE_T += 5000;

  const home = new Map(onDesk().map((w) => [w, { ...g(w) }]));
  const same = (a, b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 &&
                         Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;

  // Nothing armed: committing is a no-op rather than a trade with whatever is focused.
  P.action('swap-commit');
  assert.equal(ui.activeMode, '', 'committing with nothing armed arms nothing');
  assert.ok(same(g(p), home.get(p)) && same(g(q), home.get(q)),
    'and trades nothing: ' + show(onDesk()));

  // Begin. Twice at the same instant, which the toggle would have read as a repeat and the plugin
  // can legitimately produce -- it is not this module's business how often a trigger begins.
  P.action('swap-arm');
  P.action('swap-arm');
  assert.equal(ui.activeMode, 'swap', 'the chord going down arms the mode');
  assert.deepEqual(modes, ['swap'], 'and says so once: ' + JSON.stringify(modes));

  // The arrows choose, exactly as they do for the toggle.
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

  // And committing again does not trade back.
  const after = new Map(onDesk().map((w) => [w, { ...g(w) }]));
  P.action('swap-commit');
  settle();
  assert.ok(same(g(p), after.get(p)) && same(g(q), after.get(q)),
    'a second end trades nothing: ' + show(onDesk()));
}
console.log('17 held swap: ok');

console.log('sim27 ok');
