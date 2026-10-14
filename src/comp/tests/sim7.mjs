// Geometry is written once per action, and a client that will not take its slot is not asked again.
import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };
const out = { name: 'o1' };
const desks = [{ id: 'd1' }];
let nid = 0;
let writes = [];
function mkWin(cls, maxW) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, normalWindow: true, transient: false, dialog: false, specialWindow: false,
    desktops: [desks[0]], output: out, moveable: true, resizeable: true, minimized: false, fullScreen: false,
    move: false, resize: false, skipPager: false, maximizeMode: 0, tile: null,
    _g: { x: 100, y: 100, width: 500, height: 400 },
    minimizedChanged: sig(), fullScreenChanged: sig(), desktopsChanged: sig(), outputChanged: sig(), frameGeometryChanged: sig(),
    interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(), maximizedChanged: sig(),
    setMaximize(v, h) { w.maximizeMode = (v && h) ? 3 : 0; w.maximizedChanged.emit(); },
  };
  Object.defineProperty(w, 'frameGeometry', {
    get() { return w._g; },
    set(r) {
      writes.push(cls);
      // a client that refuses to grow past maxW, like a terminal rounding to whole character cells
      w._g = { x: r.x, y: r.y, width: maxW ? Math.min(r.width, maxW) : r.width, height: r.height };
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
const focus = (w) => { ws.activeWindow = w; ws.windowActivated.emit(w); };
function count(fn) { writes = []; fn(); const per = {}; for (const c of writes) per[c] = (per[c] || 0) + 1; return per; }

// 1. one action must not apply an intermediate layout before the final one: every extra write
//    restarts the geometry animation halfway through, which is what shows up as flickering
{
  const a = open('a'), b = open('b'), c = open('c');
  open('d');
  for (const [w, dir] of [[c, 'window-up'], [a, 'window-right'], [b, 'window-left'], [a, 'window-down']]) {
    focus(w);
    const per = count(() => P.action(dir));
    const worst = Math.max(0, ...Object.values(per));
    console.log(`1 ${dir}: ${JSON.stringify(per)}`);
    assert.ok(worst <= 1, `${dir} wrote a window's geometry ${worst} times: ${JSON.stringify(per)}`);
  }
  for (const w of wins.slice()) { wins.splice(wins.indexOf(w), 1); ws.windowRemoved.emit(w); }
}

// 2. a client that clamps its own width cannot be made to fill its slot; the tiler must notice and
//    stop re-applying the same geometry on every pass
{
  open('normal');
  open('stubborn', 600);        // its slot is 788 wide
  const settle = count(() => { for (let i = 0; i < 3; i++) { FAKE_T += 1600; P.reconcile(); } });
  console.log('2 after settling:', JSON.stringify(settle));
  const idle = count(() => { for (let i = 0; i < 5; i++) { FAKE_T += 1600; P.reconcile(); } });
  console.log('2 five idle passes:', JSON.stringify(idle));
  assert.deepEqual(idle, {}, 'an idle workspace must not move any window');
}

console.log('OK sim7');
