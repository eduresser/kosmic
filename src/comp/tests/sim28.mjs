// Regression: commitZone removed the previous drop zone first, which could dissolve its group, then handed
// drop_window a node no longer in the tree. Asserts the module never has to `audit:`-repair itself.
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

// An `audit:` line means the module found its tree in a state it should never reach.
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
// Mid-drag the placeholder slot is legitimately empty, so only the repair log is checked.
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

function drag(w, points) {
  focus(w);
  w.interactiveMoveResizeStarted.emit();
  for (const [x, y] of points) {
    ws.cursorPos = { x, y };
    w.interactiveMoveResizeStepped.emit();
    P.dragCommit();
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

// Beyond the 32px travel threshold; covers the stack zone (middle) and the group-edge bands.
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

// homeOf claiming a window that no tree holds would leave it unadopted and never laid out.
for (const w of wins) {
  assert.ok(w._g.width > 100 && w._g.height > 100,
    `${w.resourceClass} was left outside the layout: ` + show(wins));
}

// The original report: one window dragged round and round while the tree reshapes under it.
for (let i = 0; i < 20; i++) {
  drag(a, [POINTS[i % POINTS.length], POINTS[(i + 5) % POINTS.length]]);
  check('long run ' + i);
}
console.log('depois do longo:', show(wins));

// Regression: drag start/end arrive on two signals each and can interleave; a second start used to
// overwrite the grab and orphan the first placeholder, which the audit cannot see.
{
  const first = wins[0], second = wins[1];
  focus(first);
  first.interactiveMoveResizeStarted.emit();
  ws.cursorPos = { x: 800, y: 500 };
  first.interactiveMoveResizeStepped.emit();
  P.dragCommit();

  second.move = true;
  second.moveResizedChanged.emit();
  second.move = false;
  second.moveResizedChanged.emit();
  settle();
  check('after a second drag started under the first');

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
