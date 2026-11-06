// A KWin script cannot expose state (callDBus only goes out), so the tiler pushes it to the /state session
// service for the applet; an empty workspace's space is synthesised from the active output.
import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };

const d1 = { id: 'd1' };
const d2 = { id: 'd2' };
const out = { name: 'o1' };
let nid = 0;
function mkWin(cls, desk) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, caption: cls, normalWindow: true, transient: false,
    dialog: false, specialWindow: false, icon: null, noBorder: false, closed: false,
    desktops: [desk], output: out, moveable: true, resizeable: true, minimized: false,
    fullScreen: false, move: false, resize: false, maximizeMode: 0, tile: null,
    minSize: { width: 0, height: 0 },
    _g: { x: 100, y: 100, width: 500, height: 400 },
    minimizedChanged: sig(), fullScreenChanged: sig(), desktopsChanged: sig(), outputChanged: sig(),
    frameGeometryChanged: sig(), interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(),
    interactiveMoveResizeStepped: sig(), moveResizedChanged: sig(), maximizedChanged: sig(), captionChanged: sig(),
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
  currentDesktop: d1, desktops: [d1, d2], activeWindow: null, cursorPos: { x: 0, y: 0 },
  activeScreen: out,
  windowList: () => wins.slice(),
  clientArea: () => ({ x: 0, y: 32, width: 1600, height: 968 }),
};
const kw = { MaximizeArea: 1, readConfig: (k, d) => d };

// Stands in for the DBusCall in contents/ui/main.qml; only which calls happen is checked.
const published = [];
const ui = {
  activeMode: '', enforceTimer: { restart() {} }, osd: () => {},
  publishTiling: (on) => published.push(on),
  newBar: () => ({ apply() {}, destroy() {}, visible: false }),
};

const P = await import(process.argv[2]);
P.main({ workspace: ws, kwin: kw }, { root: ui, dbg: () => {} });

const open = (cls, desk = ws.currentDesktop) => {
  const w = mkWin(cls, desk);
  wins.push(w);
  ws.windowAdded.emit(w);
  ws.activeWindow = w;
  ws.windowActivated.emit(w);
  return w;
};
const goTo = (desk) => { ws.currentDesktop = desk; ws.currentDesktopChanged.emit(); };
const tiled = (w) => w._g.width !== 500 || w._g.height !== 400;   // it was laid out, so it is tiled
const drain = () => published.splice(0, published.length);

// May be lost at login if the service is not up yet, but it must be attempted.
assert.deepStrictEqual(published, [true], 'main() should publish the starting state');
drain();

P.action('publish-state');
assert.deepStrictEqual(published, [true], 'an empty workspace reports the new-workspace default');
drain();

// Regression: `if (!area) return` made the toggle dead on a workspace with no window.
P.action('tiling');
assert.deepStrictEqual(published, [false], 'toggling an empty workspace publishes the new value');
drain();

// layout() drops spaces with no windows; one that carries a decision has to survive.
P.action('publish-state');
assert.deepStrictEqual(published, [false], 'the decision survives the collection of empty spaces');
drain();

const a = open('konsole');
assert.ok(!tiled(a), 'a window opening on a workspace switched to floating should float');

// Publishing per event would put a D-Bus call on every workspace switch. d2 is empty, so it reports the
// default (true) against d1's false.
drain();
goTo(d2);
assert.deepStrictEqual(published, [true], 'changing to a workspace with a different state publishes');

drain();
goTo(d1);
goTo(d2);
assert.deepStrictEqual(published, [false, true], 'each change in value is published once');
drain();
goTo(d2);
assert.deepStrictEqual(published, [], 'a change that does not move the value publishes nothing');

// The applet calls publish-state right before reading as a liveness check (stale values expire), so it
// must answer even when the gate is shut.
drain();
P.action('publish-state');
assert.deepStrictEqual(published, [true], 'a forced publish answers even when nothing changed');
drain();
P.action('publish-state');
assert.deepStrictEqual(published, [true], 'and answers again, every time it is asked');

// An empty d2 reports the new-workspace default, so changing that default has to republish.
drain();
P.action('new-workspace-floating');
assert.deepStrictEqual(published, [false], 'changing the new-workspace default republishes');
drain();
P.action('new-workspace-floating');
assert.deepStrictEqual(published, [], 'setting it to what it already is publishes nothing');

// d1 has a space of its own, so its answer must not come from the (now floating) default.
drain();
goTo(d1);
assert.deepStrictEqual(published, [], 'd1 is floating and so is the default: no change to report');
P.action('tiling');
assert.deepStrictEqual(published, [true], 'toggling a space with a window in it publishes');
assert.ok(tiled(a), 'and the window is tiled now');

drain();
P.action('new-workspace-floating');
P.action('publish-state');
assert.deepStrictEqual(published, [true], 'a space that exists outranks the default');

console.log('sim31 ok');
