// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// Two windows whose minimum sizes do not fit next to each other, either way round. Neither Pop Shell
// (which ignores minimum sizes) nor cosmic-comp (whose tiling has none, and which only pushes a new
// tree once every client has acked the last one) keeps resizing in that case: the layout is left
// broken -- windows overlap -- instead of oscillating forever.
import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };
const out = { name: 'o1' };
const desks = [{ id: 'd1' }];
let nid = 0;
let writes = [];
// A client that will not go below minSize, like systemsettings or the widget explorer.
function mkWin(cls, min) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, normalWindow: true, transient: false, dialog: false, specialWindow: false,
    desktops: [desks[0]], output: out, moveable: true, resizeable: true, minimized: false, fullScreen: false,
    move: false, resize: false, skipPager: false, maximizeMode: 0, tile: null,
    minSize: min || { width: 0, height: 0 },
    _g: { x: 100, y: 100, width: 900, height: 700 },
    minimizedChanged: sig(), fullScreenChanged: sig(), desktopsChanged: sig(), outputChanged: sig(), frameGeometryChanged: sig(),
    interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(), maximizedChanged: sig(),
    setMaximize(v, h) { w.maximizeMode = (v && h) ? 3 : 0; w.maximizedChanged.emit(); },
  };
  Object.defineProperty(w, 'frameGeometry', {
    get() { return w._g; },
    set(r) {
      writes.push(`${cls} ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      w._g = { x: r.x, y: r.y, width: Math.max(r.width, w.minSize.width), height: Math.max(r.height, w.minSize.height) };
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
P.main({ workspace: ws, kwin: { MaximizeArea: 1 } }, { root: { activeMode: "", enforceTimer: { restart() {} } }, dbg: () => {} });
const open = (c, m) => { const w = mkWin(c, m); wins.push(w); ws.windowAdded.emit(w); ws.activeWindow = w; ws.windowActivated.emit(w); return w; };
const count = (fn) => { writes = []; fn(); return writes; };
const show = (w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`;

// 1600x968 of work area: 1000+1000 does not fit across, 700+700 does not fit down.
const big = { width: 1000, height: 700 };
const a = open('settings', big);
const b = open('widgets', big);

const settling = count(() => { for (let i = 0; i < 6; i++) { FAKE_T += 1600; P.reconcile(); } });
console.log('settling writes:', settling.length);
console.log('layout:', show(a), show(b));
const idle = count(() => { for (let i = 0; i < 8; i++) { FAKE_T += 1600; P.reconcile(); } });
console.log('idle writes:', idle);
assert.deepEqual(idle, [], 'an impossible layout must stop being re-applied, not resized forever');
assert.ok(settling.length <= 8, `gave up only after ${settling.length} writes`);
// Breaking the layout is the point: both windows keep their minimum size.
assert.ok(a._g.width >= big.width && b._g.width >= big.width, 'both windows keep their minimum width');

// 2. closing one of them must bring the layout back: a refused rect is only refused for that layout.
{
  wins.splice(wins.indexOf(b), 1); ws.windowRemoved.emit(b);
  FAKE_T += 1600; P.reconcile();
  console.log('2 alone:', show(a));
  assert.equal(Math.round(a._g.width), 1584, 'the window left behind must take the whole area');
}

// 3. a third window on top of two impossible ones still converges.
{
  const c = open('widgets', big);
  const d = open('konsole');
  const idle = count(() => { for (let i = 0; i < 8; i++) { FAKE_T += 1600; P.reconcile(); } });
  console.log('3 layout:', show(a), show(c), show(d));
  assert.deepEqual(idle, [], 'three windows, two of them too big, must still settle');
  for (const w of [c, d]) { wins.splice(wins.indexOf(w), 1); ws.windowRemoved.emit(w); }
  FAKE_T += 1600; P.reconcile();
}

// 4. cosmic-comp (shell/layout/mod.rs is_dialog): a window that cannot be resized -- minimum size
//    equal to maximum size -- is a dialog, and dialogs float.
{
  const fixed = mkWin('splash', { width: 600, height: 400 });
  fixed.maxSize = { width: 600, height: 400 };
  wins.push(fixed); ws.windowAdded.emit(fixed); ws.activeWindow = fixed; ws.windowActivated.emit(fixed);
  FAKE_T += 1600; P.reconcile();
  console.log('4 fixed-size window:', show(fixed), ' tiled window:', show(a));
  assert.deepEqual(fixed._g, { x: 100, y: 100, width: 900, height: 700 }, 'a fixed-size window must never be touched');
  assert.equal(Math.round(a._g.width), 1584, 'and must not take a slot from the tree');
}
console.log('OK sim8');
