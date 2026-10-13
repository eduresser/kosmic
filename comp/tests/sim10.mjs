// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// Closing windows out of a stack: whatever order they go in, what is left is laid out again.
// A member that is not in front is not in the tree, so dropping it changes nothing the layout can
// see -- except that the last window of a stack takes back the strip the tab bar was holding.
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
    interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(), maximizedChanged: sig(), captionChanged: sig(),
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

const g = (w) => w._g;
const show = (l) => l.map((w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`).join(' ');
const settle = (n = 4) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };
const same = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
function close(w) { wins.splice(wins.indexOf(w), 1); ws.windowRemoved.emit(w); }
function focus(w) { ws.activeWindow = w; ws.windowActivated.emit(w); return w; }
function open(cls) { const w = mkWin(cls); wins.push(w); ws.windowAdded.emit(w); focus(w); return w; }
function perms(a) { if (a.length <= 1) return [a]; const o = []; a.forEach((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).forEach((p) => o.push([x, ...p]))); return o; }
const BAR = 28;
const FULL = { x: 8, y: 40, width: 1584, height: 952 };
// A stack of one is still a stack (CosmicStack holds a list, not a pair), so the last window out of
// a stack keeps the bar and the strip under it. Only a window that was never in one gets the lot.
const FULL_STACKED = { x: FULL.x, y: FULL.y + BAR, width: FULL.width, height: FULL.height - BAR };

// Drop `w` on the middle of `target`, which is TargetZone::WindowStack: the target becomes a stack
// and w joins it. Super+S cannot be used to merge -- ToggleStacking :2132 only ever turns the
// focused window into a stack of its own -- so a stack is built by dropping or by moving into one.
function dropOn(w, target) {
  const t = g(target);
  ws.cursorPos = { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  focus(w);
  w.interactiveMoveResizeStarted.emit();
  w.interactiveMoveResizeFinished.emit();
}

let lone = 0;
for (const n of [2, 3, 4]) for (const merged of [2, 3, 4].filter((m) => m <= n)) {
  for (const order of perms([...Array(n).keys()])) {
    for (const w of wins.slice()) close(w);
    const list = [];
    for (let i = 0; i < n; i++) list.push(open('w' + i));
    for (let i = 1; i < merged; i++) dropOn(list[i], list[0]);   // merge the first `merged` of them
    settle();
    for (const i of order) {
      if (wins.indexOf(list[i]) < 0) continue;
      focus(list[i]);
      close(list[i]);
      settle();
      if (wins.length !== 1) continue;
      lone++;
      const wasStacked = list.indexOf(wins[0]) < merged;
      const want = wasStacked ? FULL_STACKED : FULL;
      assert.ok(same(g(wins[0]), want),
        `n=${n} merged=${merged} order=${order}: the last window should fill the work area, got ${show(wins)}`);
      assert.equal(!!wins[0].noBorder, wasStacked,
        `n=${n} merged=${merged} order=${order}: only a window still in a stack gives up its decoration`);
    }
  }
}
assert.ok(lone >= 80, 'the matrix should end with one window many times over, got ' + lone);
console.log(`sim10 ok (${lone} close orders)`);
