// Regression: activating a panel popup (specialWindow) moved `cur` and hid the active hint. Both halves are
// needed: the activation handler ignores chrome, and updateSelection falls back to the last real window.
import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };

const out = { name: 'o1' };
const d1 = { id: 'd1' };
let nid = 0;
function mkWin(cls) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, caption: cls, normalWindow: true, transient: false,
    dialog: false, specialWindow: false, skipPager: false, icon: null, noBorder: false,
    desktops: [d1], output: out, moveable: true, resizeable: true, minimized: false,
    fullScreen: false, move: false, resize: false, maximizeMode: 0, tile: null,
    minSize: { width: 0, height: 0 },
    _g: { x: 100, y: 100, width: 500, height: 400 },
    minimizedChanged: sig(), fullScreenChanged: sig(), desktopsChanged: sig(), outputChanged: sig(),
    frameGeometryChanged: sig(), interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(),
    interactiveMoveResizeStepped: sig(), moveResizedChanged: sig(), maximizedChanged: sig(), captionChanged: sig(),
    setMaximize(v, h) { w.maximizeMode = (v && h) ? 3 : 0; w.maximizedChanged.emit(); },
  };
  Object.defineProperty(w, 'frameGeometry', {
    get() { return w._g; },
    set(r) { w._g = { x: r.x, y: r.y, width: r.width, height: r.height }; w.frameGeometryChanged.emit(); },
  });
  return w;
}

// Flags transcribed from a live windowActivated log: `cls=org.kde.plasmashell | appletPopup,specialWindow,managed | wtype=18`.
function mkPopup() {
  const w = mkWin('org.kde.plasmashell');
  w.normalWindow = false;
  w.specialWindow = true;
  w.onAllDesktops = true;
  w.desktops = [];
  w.moveable = false;
  w.resizeable = false;
  return w;
}

const wins = [];
const ws = {
  windowAdded: sig(), windowRemoved: sig(), windowActivated: sig(), currentDesktopChanged: sig(),
  currentDesktop: d1, desktops: [d1], activeWindow: null, cursorPos: { x: 0, y: 0 },
  activeScreen: out,
  windowList: () => wins.slice(),
  clientArea: () => ({ x: 0, y: 32, width: 1600, height: 968 }),
};
const kw = { MaximizeArea: 1, readConfig: (k, d) => d };

// focusdim and the outline plugin read the Selection marker's rect, so that rect is what is asserted.
const mark = { shown: false, rect: null };
const modes = [];
const ui = {
  activeMode: '', enforceTimer: { restart() {} }, osd: () => {},
  modeOsd: (m) => modes.push(m),
  publishTiling: () => {},
  showSelection(x, y, w, h) { mark.shown = true; mark.rect = { x, y, w, h }; return true; },
  hideSelection() { mark.shown = false; },
  newBar: () => ({ apply() {}, destroy() {}, visible: false }),
};

const P = await import(process.argv[2]);
P.main({ workspace: ws, kwin: kw }, { root: ui, dbg: () => {} });

const focus = (w) => { ws.activeWindow = w; ws.windowActivated.emit(w); return w; };
const open = (cls) => { const w = mkWin(cls); wins.push(w); ws.windowAdded.emit(w); return focus(w); };
const key = () => (mark.shown && mark.rect ? `${mark.rect.x},${mark.rect.y} ${mark.rect.w}x${mark.rect.h}` : 'hidden');

const left = open('konsole');
const right = open('firefox');
assert.ok(mark.shown, 'the focused window should be marked');
const onRight = key();

const popup = mkPopup();
wins.push(popup);
ws.windowAdded.emit(popup);
focus(popup);
assert.ok(mark.shown, 'opening a panel popup must not hide the active hint');
assert.strictEqual(key(), onRight, 'and must not move it');

// arrange() runs updateSelection on every timer pass, which used to hide the hint while the popup held focus.
P.reconcile();
assert.ok(mark.shown, 'a layout pass while the popup holds focus must not hide it either');
assert.strictEqual(key(), onRight, 'nor move it');

// Swap is a toggle here (KWin gives no key release), so it can be on while the user reaches for the panel.
// Armed via swap-arm because the toggle reads two presses at a frozen clock as one key repeat.
focus(right);
P.action('swap-arm');
assert.strictEqual(ui.activeMode, 'swap', 'swap mode should be on');
focus(popup);
assert.strictEqual(ui.activeMode, 'swap', 'a panel popup must not cancel the mode');
P.action('swap-commit');
assert.strictEqual(ui.activeMode, '', 'and it still ends when asked');

focus(right);
assert.ok(mark.shown, 'the hint is still there when focus comes back');
assert.strictEqual(key(), onRight, 'on the same window');

focus(left);
assert.ok(mark.shown, 'focusing another window keeps the hint up');
assert.notStrictEqual(key(), onRight, 'and moves it to that window');

// KWin's specialWindow excludes dialogs on purpose; widening the guard to `!normalWindow` would fail here.
const dlg = mkWin('konsole');
dlg.normalWindow = false;
dlg.dialog = true;
wins.push(dlg);
ws.windowAdded.emit(dlg);
focus(dlg);
assert.ok(!mark.shown, 'a dialog is focus, and it has no slot, so the hint goes out');

console.log('sim32 ok');
