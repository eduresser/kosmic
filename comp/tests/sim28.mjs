// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// Dragging, for a long time, without the tree quietly coming apart.
//
// The report this was written from: five windows, drag until the drop zone covers the whole screen,
// and afterwards four of the five are in no tree at all -- still claimed by homeOf, so nothing
// adopts them, sitting wherever they were last written while new windows open over the top. The
// dump showed a group carrying three sizes for one child, which is the shape of the damage:
// measure() pushes one rect per size and pops one per child, so the two disagreeing strands every
// rect after the mismatch.
//
// The cause was a zone applied to a tree it was not computed against. commitZone took the previous
// drop zone out first, which dissolves the group that held it whenever that group was down to two
// children, and then handed drop_window a `node` that was no longer in the tree.
//
// So this does not assert a layout. It asserts that the module never has to repair itself: every
// `audit:` line is the tree having come apart somewhere upstream of it, and the audit exists to
// keep a session usable, not to make a test pass.
import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };
const desk = { id: 'd1' };
const out = { name: 'o1' };
let nid = 0;
function mkWin(cls) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, caption: cls + ' — title',
    normalWindow: true, transient: false, dialog: false, specialWindow: false,
    desktops: [desk], output: out, moveable: true, resizeable: true, minimized: false,
    fullScreen: false, move: false, resize: false, skipPager: false, maximizeMode: 0, tile: null,
    noBorder: false, closed: false,
    _g: { x: 100, y: 100, width: 500, height: 400 },
    minimizedChanged: sig(), fullScreenChanged: sig(), desktopsChanged: sig(), outputChanged: sig(),
    frameGeometryChanged: sig(), captionChanged: sig(), maximizedChanged: sig(),
    interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(),
    interactiveMoveResizeStepped: sig(), moveResizedChanged: sig(),
    setMaximize(v, h) { w.maximizeMode = (v && h) ? 3 : 0; w.maximizedChanged.emit(); },
    closeWindow() { w.closed = true; },
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
  desktops: [desk], currentDesktop: desk, activeWindow: null, cursorPos: { x: 0, y: 0 },
  windowList: () => wins.slice(),
  clientArea: () => ({ x: 0, y: 32, width: 1600, height: 968 }),
  createDesktop() {}, removeDesktop() {},
  showOutline() {}, hideOutline() {},
};
const kw = { MaximizeArea: 1 };
const bars = [];
const ui = {
  activeMode: "", enforceTimer: { restart() {} }, osd: () => {},
  dragTimer: { interval: 0, restart() {} },
  newBar() {
    const o = {
      visible: false, destroyed: false, rect: null,
      apply(id, rect) { o.rect = rect; o.visible = true; },
      destroy() { o.destroyed = true; o.visible = false; },
    };
    bars.push(o);
    return o;
  },
  showZone() { return true; },
  hideZone() {},
};

// Every line the module writes. An `audit:` line is the module telling us it found the tree in a
// state it should never have been in, which is the whole point of this file.
const said = [];
const P = await import(process.argv[2]);
P.main({ workspace: ws, kwin: kw }, { root: ui, dbg: (m) => said.push(String(m)) });

const AREA = { x: 0, y: 32, width: 1600, height: 968 };
const INNER = 8;
const g = (w) => w._g;
const show = (l) => l.map((w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`).join(' ');
function focus(w) { ws.activeWindow = w; ws.windowActivated.emit(w); return w; }
function open(cls) { const w = mkWin(cls); wins.push(w); ws.windowAdded.emit(w); focus(w); return w; }
const settle = (n = 2) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };

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
      for (const r of rects) if (x >= r.x && x < r.r2 && y >= r.y && y < r.b2) { hit = true; break; }
      if (!hit) return { x, y };
    }
  }
  return null;
}

let auditedAt = 0;
// Mid-drag the layout legitimately has a hole in it -- the dragged window's slot is a placeholder
// and nothing is written into it, which is the whole point of the live preview. So only the repair
// log is checked while a drag is in flight; coverage is a question for after the drop.
function checkAudit(where) {
  const repairs = said.filter((m) => m.startsWith('audit:'));
  assert.equal(repairs.length, auditedAt, where +
    ': the module had to repair its own tree -- ' + repairs.slice(auditedAt).join(' | '));
}
function check(where) {
  const repairs = said.filter((m) => m.startsWith('audit:'));
  assert.equal(repairs.length, auditedAt, where +
    ': the module had to repair its own tree -- ' + repairs.slice(auditedAt).join(' | '));
  const hole = uncovered(wins);
  assert.equal(hole, null, `${where}: wallpaper showing through at ${JSON.stringify(hole)} -- ${show(wins)}`);
}

// A drag, driven the way KWin drives one: a start, a run of pointer steps each followed by the
// dwell timer firing, and a release.
function drag(w, points) {
  focus(w);
  w.interactiveMoveResizeStarted.emit();
  for (const [x, y] of points) {
    ws.cursorPos = { x, y };
    w.interactiveMoveResizeStepped.emit();
    P.dragCommit();
    // The dragged window belongs to the cursor while this lasts, exactly as KWin has it.
    w._g = { x: x - 100, y: y - 20, width: w._g.width, height: w._g.height };
    checkAudit(`mid-drag of ${w.resourceClass} at ${x},${y}`);
  }
  w.interactiveMoveResizeFinished.emit();
  settle();
}

const a = open('a'), b = open('b'), c = open('c'), d = open('d'), e = open('e');
settle();
check('after opening five');
console.log('inicial:', show(wins));

// A sweep of the screen, well clear of the 32px travel the module wants before it reconsiders.
// Deliberately includes the middle, which is the stack zone, and the four edges, which are the
// group bands -- the two arms of drop_window that insert into an existing group rather than
// wrapping one, and so the two that care most about the group still being in the tree.
const POINTS = [
  [120, 120], [800, 500], [1480, 120], [1480, 880], [120, 880],
  [800, 80], [40, 500], [1560, 500], [800, 950], [400, 300], [1200, 700],
];
for (let round = 0; round < 3; round++) {
  for (const w of [a, b, c, d, e]) {
    drag(w, POINTS);
    check(`after dropping ${w.resourceClass} (round ${round})`);
  }
}
console.log('depois de arrastar:', show(wins));

// Every window is still in the layout, which is the part homeOf claiming one and no tree holding
// it would quietly break: nothing adopts such a window and nothing lays it out.
for (const w of wins) {
  assert.ok(w._g.width > 100 && w._g.height > 100,
    `${w.resourceClass} was left outside the layout: ` + show(wins));
}

// And a long run over one window, which is what "drag until the placeholder covers the screen"
// actually is: the same window going round and round while the rest of the tree reshapes under it.
for (let i = 0; i < 20; i++) {
  drag(a, [POINTS[i % POINTS.length], POINTS[(i + 5) % POINTS.length]]);
  check('long run ' + i);
}
console.log('depois do longo:', show(wins));

// ---------- a second drag starting before the first one ended ----------
//
// Both ends of a drag are heard on two signals apiece -- interactiveMoveResizeStarted/Finished and
// moveResizedChanged -- because one of them has already been seen not to arrive. The cost is that
// they can interleave, and a start for one window arriving while another is still grabbed used to
// overwrite the grab: the first window's placeholder stayed in the tree with nothing left that knew
// about it. The audit cannot see such a leaf -- every check there asks about the window in a leaf,
// and this one has none -- so it sits there as a slot nothing is ever written into.
{
  const first = wins[0], second = wins[1];
  focus(first);
  first.interactiveMoveResizeStarted.emit();
  ws.cursorPos = { x: 800, y: 500 };
  first.interactiveMoveResizeStepped.emit();
  P.dragCommit();

  // KWin now says the other window is being moved, with nothing said about the first.
  second.move = true;
  second.moveResizedChanged.emit();
  second.move = false;
  second.moveResizedChanged.emit();
  settle();
  check('after a second drag started under the first');

  // And the first one, whose end never came, is finished rather than left behind.
  first.interactiveMoveResizeFinished.emit();
  settle();
  check('after the first drag finally ends');
  for (const w of wins) {
    assert.ok(w._g.width > 100 && w._g.height > 100,
      w.resourceClass + ' is still in the layout: ' + show(wins));
  }
}
console.log('interleaved drags: ok');

console.log('sim28 ok');
