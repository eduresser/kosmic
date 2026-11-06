// Regression: Konsole lands a pixel short (cell rounding), which was recorded as refusing its slot, so a
// later layout skipped the write and left wallpaper. A refusal means "handed this, from here, did not move".
import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };
const out = { name: 'o1' };
const desks = [{ id: 'd1' }];
let nid = 0;
const writes = new Map();

// `cell`: height rounded down like a terminal. `floorW`: minimum width like a dialog.
function mkWin(cls, cell, floorW) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, caption: cls, normalWindow: true, transient: false,
    dialog: false, specialWindow: false, desktops: [desks[0]], output: out, moveable: true,
    resizeable: true, minimized: false, fullScreen: false, move: false, resize: false,
    skipPager: false, maximizeMode: 0, tile: null, noBorder: false,
    _g: { x: 100, y: 100, width: 500, height: 400 },
    minimizedChanged: sig(), fullScreenChanged: sig(), desktopsChanged: sig(), outputChanged: sig(),
    frameGeometryChanged: sig(), captionChanged: sig(), maximizedChanged: sig(),
    interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(),
    interactiveMoveResizeStepped: sig(), moveResizedChanged: sig(),
    setMaximize(v, h) { w.maximizeMode = (v && h) ? 3 : 0; w.maximizedChanged.emit(); },
  };
  Object.defineProperty(w, 'frameGeometry', {
    get() { return w._g; },
    set(r) {
      writes.set(cls, (writes.get(cls) || 0) + 1);
      if (w.deaf) return;   // a client that is not answering configures right now
      w._g = {
        x: r.x, y: r.y,
        width: floorW ? Math.max(r.width, floorW) : r.width,
        height: cell ? r.height - cell : r.height,
      };
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
const P = await import(process.argv[2]);
P.main({ workspace: ws, kwin: { MaximizeArea: 1 } },
       { root: { activeMode: "", enforceTimer: { restart() {} } }, dbg: () => {} });

const g = (w) => w._g;
const show = (l) => l.map((w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`).join(' ');
const settle = (n = 6) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };
function focus(w) { ws.activeWindow = w; ws.windowActivated.emit(w); return w; }
function open(cls, cell, floorW) {
  const w = mkWin(cls, cell, floorW); wins.push(w); ws.windowAdded.emit(w); focus(w); return w;
}
const AREA = { x: 0, y: 32, width: 1600, height: 968 };
const INNER = 8;
function uncovered() {
  const rects = wins.map((w) => {
    const r = g(w);
    return { x: r.x - INNER, y: r.y - INNER, r2: r.x + r.width + INNER, b2: r.y + r.height + INNER };
  });
  for (let x = AREA.x + 4; x < AREA.x + AREA.width; x += 16) {
    for (let y = AREA.y + 4; y < AREA.y + AREA.height; y += 16) {
      let hit = false;
      for (const r of rects) if (x >= r.x && x < r.r2 && y >= r.y && y < r.b2) { hit = true; break; }
      if (!hit) return { x, y };
    }
  }
  return null;
}

const a = open('a', 1), b = open('b', 1), c = open('c', 1), d = open('d', 1), e = open('e', 1);
settle(10);
console.log('1 five terminals:', show(wins));
assert.equal(uncovered(), null, 'no wallpaper showing through: ' + show(wins));

// Re-asking a settled window only replays its resize animation, so nothing should be written.
writes.clear();
settle(10);
assert.equal(writes.size, 0, 'a settled layout writes nothing: ' + JSON.stringify([...writes]));

const DIRS = ['left', 'right', 'up', 'down'];
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
for (let i = 0; i < 600; i++) {
  focus(wins[rnd(wins.length)]);
  P.action('window-' + DIRS[rnd(DIRS.length)]);
  settle(2);
  const hole = uncovered();
  assert.equal(hole, null, `step ${i}: wallpaper showing through at ${JSON.stringify(hole)} -- ${show(wins)}`);
}
console.log('2 after 600 moves:', show(wins));

// A refusal must expire once the window leaves that position, or a later layout reusing the rect skips it.
{
  for (const w of wins.slice()) { wins.splice(wins.indexOf(w), 1); ws.windowRemoved.emit(w); }
  const x = open('x', 0, 0), y = open('y', 0, 0);
  settle(10);
  const slot = { ...g(x) };
  console.log('3 start:', show([x, y]));

  x.deaf = true;
  x._g = { x: 1070, y: 500, width: 522, height: 300 };
  x.frameGeometryChanged.emit();
  settle(10);
  assert.notEqual(Math.round(g(x).x), slot.x, 'it did not take the rect it was handed: ' + show([x, y]));

  x.deaf = false;
  x._g = { x: 300, y: 300, width: 400, height: 300 };
  x.frameGeometryChanged.emit();
  writes.clear();
  settle(10);
  console.log('3 end:  ', show([x, y]));
  assert.ok(Math.abs(g(x).x - slot.x) <= 1 && Math.abs(g(x).y - slot.y) <= 1 &&
            Math.abs(g(x).width - slot.width) <= 1 && Math.abs(g(x).height - slot.height) <= 1,
    'a window that has moved since it refused is asked again, and put back: ' + show([x, y]));
  assert.equal(uncovered(), null, 'and its slot is not left showing the wallpaper: ' + show([x, y]));
}

console.log('sim29 ok');
