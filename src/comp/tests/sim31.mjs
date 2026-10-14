// The tiling state leaving the script, and the empty workspace that made it necessary.
//
// The panel applet's "Tile current workspace" is a switch, which means something has to tell it
// what to show. A KWin script can publish nothing -- callDBus only goes out, there is no
// writeConfig, and the scripting API registers no service -- so the tiler pushes the value to a
// session service instead (/state) and the applet reads it from there. Everything
// below is about that push: when it happens, when it deliberately does not, and what it says.
//
// The other half is the empty workspace. Deciding how a workspace behaves before opening anything
// on it is the ordinary way round, and upstream's applet toggles an empty workspace like any
// other -- but a space here is keyed by (output, desktop) and used to be reachable only through a
// window that was already in it. A switch that silently does nothing is worse than the button it
// replaced, so the key is synthesised from the active output when no window answers, and the
// space that results has to survive the collection that drops empty ones.
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

// What the script pushes, in order. The real one is a DBusCall in contents/ui/main.qml; here it is
// a list, because what is being checked is which calls happen and not what is on the wire.
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

// ---------- it says something at all ----------
//
// main() publishes once, so the service holds a value before anybody has opened the popup. It is
// allowed to be lost -- at login the service may not be up yet -- but it must be attempted, or a
// session where nothing ever changes would never publish at all.
assert.deepStrictEqual(published, [true], 'main() should publish the starting state');
drain();

// ---------- an empty workspace ----------
//
// Nothing is open. The space does not exist, and the honest answer is what a space created here
// would be born with rather than "nothing to say".
P.action('publish-state');
assert.deepStrictEqual(published, [true], 'an empty workspace reports the new-workspace default');
drain();

// The toggle has to reach it. This is the case the old `if (!area) return` made dead: no window,
// so no work area, so the control did nothing at all.
P.action('tiling');
assert.deepStrictEqual(published, [false], 'toggling an empty workspace publishes the new value');
drain();

// And it has to stick. layout() drops a space with no windows, because one that says nothing is
// indistinguishable from one that was never made -- but this one now says something.
P.action('publish-state');
assert.deepStrictEqual(published, [false], 'the decision survives the collection of empty spaces');
drain();

// The whole point of making it stick: the next window to open here floats.
const a = open('konsole');
assert.ok(!tiled(a), 'a window opening on a workspace switched to floating should float');

// ---------- the gate ----------
//
// A push per event rather than per change would put a D-Bus call on the workspace-switch path for
// workspaces that have nothing to report. d2 has nothing open, so it answers with the default --
// which is true, and the current one is false, so this one does change.
drain();
goTo(d2);
assert.deepStrictEqual(published, [true], 'changing to a workspace with a different state publishes');

// Back and forth between two readings that agree says nothing. d2 is empty and reports the
// default; so would any other empty one.
drain();
goTo(d1);
goTo(d2);
assert.deepStrictEqual(published, [false, true], 'each change in value is published once');
drain();
goTo(d2);
assert.deepStrictEqual(published, [], 'a change that does not move the value publishes nothing');

// ---------- forced ----------
//
// The applet calls publish-state immediately before reading, and that call is the liveness check:
// a value nobody refreshed expires in the service and the applet shows no state rather than a
// stale one. So it has to answer even when the gate would have stayed shut.
drain();
P.action('publish-state');
assert.deepStrictEqual(published, [true], 'a forced publish answers even when nothing changed');
drain();
P.action('publish-state');
assert.deepStrictEqual(published, [true], 'and answers again, every time it is asked');

// ---------- the default moves the answer ----------
//
// d2 has nothing open, so what it reports is whatever a space made here would start as. The
// applet's "New workspace behavior" control moves exactly that, so it has to republish.
drain();
P.action('new-workspace-floating');
assert.deepStrictEqual(published, [false], 'changing the new-workspace default republishes');
drain();
P.action('new-workspace-floating');
assert.deepStrictEqual(published, [], 'setting it to what it already is publishes nothing');

// ---------- a real workspace ----------
//
// Back to d1, which has a window and a space of its own, so the answer comes from the space and
// not from the default -- which is now floating and would be the wrong answer.
drain();
goTo(d1);
assert.deepStrictEqual(published, [], 'd1 is floating and so is the default: no change to report');
P.action('tiling');
assert.deepStrictEqual(published, [true], 'toggling a space with a window in it publishes');
assert.ok(tiled(a), 'and the window is tiled now');

// A space with a window reports its own state even when the default disagrees.
drain();
P.action('new-workspace-floating');
P.action('publish-state');
assert.deepStrictEqual(published, [true], 'a space that exists outranks the default');

console.log('sim31 ok');
