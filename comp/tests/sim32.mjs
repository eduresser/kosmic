// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// Desktop chrome taking the keyboard is not a focus change.
//
// KWin activates a panel widget's popup like any other window: `specialWindow` is true, and
// `normalWindow` is false. The tiler used to take that at face value -- it moved `cur`, exited
// whatever mode was running, dropped the group selection, and then looked for a slot to put the
// active hint on, found a window with no desktop and nothing tilable about it, and hid the hint.
//
// The visible result was that opening the KOSMIC applet blanked the active hint that the applet
// configures, which is the one moment it must not. Measured on the live session before the fix:
// the line around the focused window disappeared the instant a popup opened and came back when it
// closed. COSMIC never meets this, because its panel is a layer-shell surface and focus landing on
// one does not move the focused tiling element.
//
// What is checked here is both halves of the repair, because either alone leaves the bug: the
// activation handler ignores chrome, *and* updateSelection falls back to the last real window --
// without the second, the next layout pass hides the hint while the popup is still up.
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

// The applet popup, as KWin hands it over. Transcribed from a live session rather than invented:
// a KWin script logging every windowActivated while the launcher was opened and closed printed
//
//   cls=org.kde.plasmashell | appletPopup,specialWindow,managed | wtype=18
//
// so the flags below are those flags -- no desktop, on all of them, nothing normal about it.
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

// Stands in for the Selection marker main.qml creates. It draws nothing itself -- the outline
// plugin and the focusdim effect read its rect -- so what is asserted is the rect they are handed.
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

// ---------- the hint is up ----------
const left = open('konsole');
const right = open('firefox');
assert.ok(mark.shown, 'the focused window should be marked');
const onRight = key();

// ---------- a popup opens ----------
//
// The applet's own popup, activated the way KWin activates one. Nothing about the tiling has
// changed, so neither should the marker -- not hidden, not moved onto a window with no slot.
const popup = mkPopup();
wins.push(popup);
ws.windowAdded.emit(popup);
focus(popup);
assert.ok(mark.shown, 'opening a panel popup must not hide the active hint');
assert.strictEqual(key(), onRight, 'and must not move it');

// The half the activation guard alone does not cover. arrange() calls updateSelection on every
// pass, and the correction loop runs on a timer -- so with the popup still holding the keyboard,
// a layout pass used to be enough to hide the hint a moment after it survived being opened.
P.reconcile();
assert.ok(mark.shown, 'a layout pass while the popup holds focus must not hide it either');
assert.strictEqual(key(), onRight, 'nor move it');

// ---------- a mode survives it ----------
//
// Swap is a toggle here rather than a held chord (KWin delivers an activation and never a release),
// so it can be on while the user reaches for the panel. Ending it on a popup would trade nothing
// and say nothing.
// Armed through the held-chord pair rather than the toggle, because the toggle recognises a key
// repeat by its timing and the clock is frozen here -- two presses at the same instant are one
// gesture to it, which is the point of that code and not a thing to work around.
focus(right);
P.action('swap-arm');
assert.strictEqual(ui.activeMode, 'swap', 'swap mode should be on');
focus(popup);
assert.strictEqual(ui.activeMode, 'swap', 'a panel popup must not cancel the mode');
P.action('swap-commit');
assert.strictEqual(ui.activeMode, '', 'and it still ends when asked');

// ---------- the popup closes ----------
focus(right);
assert.ok(mark.shown, 'the hint is still there when focus comes back');
assert.strictEqual(key(), onRight, 'on the same window');

// ---------- ordinary focus still moves it ----------
//
// The guard must not have turned into "never follow focus again". A real window takes the hint.
focus(left);
assert.ok(mark.shown, 'focusing another window keeps the hint up');
assert.notStrictEqual(key(), onRight, 'and moves it to that window');

// ---------- a dialog is not chrome ----------
//
// `specialWindow` is KWin's own set -- desktop, dock, splash, toolbar, notification, OSD, applet
// popup -- and a dialog is deliberately not in it. A dialog is a window, it is where the keyboard
// went, and the hint goes with it. This is the line between the two, asserted so that widening
// the guard to "not normalWindow" would fail here.
const dlg = mkWin('konsole');
dlg.normalWindow = false;
dlg.dialog = true;
wins.push(dlg);
ws.windowAdded.emit(dlg);
focus(dlg);
assert.ok(!mark.shown, 'a dialog is focus, and it has no slot, so the hint goes out');

console.log('sim32 ok');
