// The focus dim effect: who stays lit, and who the compositor darkens.
//
// This is the indicator now. The outline that used to draw the selection could not be stacked
// under a menu -- a KWin script's overlay is an internal window and belongsToLayer puts every
// internal window in OverlayLayer before it looks at a type -- so it is gone, and the compositor
// dims every window the selection does not cover instead.
//
// The effect runs in its own JavaScript engine and cannot call the tiler, so the two talk through
// a window: an empty dialog captioned "kosmic-selection" that the tiler moves over the selected
// rect. Everything below is a question about reading that channel, and the ones that matter are
// not the ordinary case -- they are what happens when the channel says nothing, says something
// impossible, or goes away entirely, because the effect holds its end value for as long as a
// window lives and a reader that guesses wrong leaves the screen dark with nothing left running
// to undo it.
//
// What this does NOT check: that the file parses in QJSEngine. Node is far more forgiving, and
// qml/load.qml cannot cover an effect, because an effect's main.js is a script that runs on load
// rather than a module that can be imported. The effect keeps to the same subset the tiler does.
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

// Found beside the tiler the suite is pointed at, so running the suite against an extracted copy
// tests that copy's effect and not this checkout's.
const EFFECT = path.resolve(path.dirname(process.argv[2]), '../../../focusdim/contents/code/main.js');

const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };

const SCREEN = { name: 'DP-1' };
const OTHER = { name: 'HDMI-1' };

let nid = 0;
function mkWin(over) {
  const w = {
    id: ++nid, caption: '', windowClass: 'konsole konsole', deleted: false, visible: true,
    minimized: false, normalWindow: true, popupWindow: false, dock: false, desktopWindow: false,
    onScreenDisplay: false, notification: false, criticalNotification: false, dndIcon: false,
    lockScreen: false, onCurrentDesktop: true, fullScreen: false, screen: SCREEN,
    geometry: { x: 0, y: 0, width: 100, height: 100 },
    windowFrameGeometryChanged: sig(), windowDesktopsChanged: sig(), minimizedChanged: sig(),
    windowFullScreenChanged: sig(), windowHiddenChanged: sig(),
  };
  return Object.assign(w, over || {});
}

// The animation handles the effect is handed back. `set` holds its end value, `redirect` turns a
// live one round, `cancel` tears it down -- the same three calls dialogparent uses, which is the
// in-tree effect this one is shaped after.
let anims = new Map();
let byWindow = new Map();
let sets = 0;
let redirects = 0;
const Effect = { Saturation: 'saturation', Brightness: 'brightness', Forward: 'forward', Backward: 'backward' };

function reset() { anims = new Map(); byWindow = new Map(); sets = 0; redirects = 0; }

const effects = {
  windowAdded: sig(), windowClosed: sig(), desktopChanged: sig(),
  hasActiveFullScreenEffectChanged: sig(), colorPickerActiveChanged: sig(),
  stackingOrder: [], hasActiveFullScreenEffect: false, colorPickerActive: false,
};

let config = { Strength: 30, Duration: 250, Debug: false };
const effect = { configChanged: sig(), readConfig: (k, d) => (k in config ? config[k] : d) };

function makeCtx() {
  return vm.createContext({
  effect, effects, Effect, QEasingCurve: { InOutQuad: 'inOutQuad' },
  animationTime: (t) => t,
  print: () => {},
  Math, JSON, String, Number, Object, Array,
  set(o) {
    sets++;
    const id = 'a' + sets;
    anims.set(id, { window: o.window, dir: 'forward', alive: true, animations: o.animations, duration: o.duration });
    byWindow.set(o.window, id);
    return id;
  },
  redirect(id, dir) {
    redirects++;
    const a = anims.get(id);
    if (!a || !a.alive) return false;
    a.dir = dir;
    return true;
  },
  cancel(id) { const a = anims.get(id); if (a) a.alive = false; },
  complete(id) { void id; },
  });
}

// What the screen actually looks like: a window is dimmed when a live animation is playing towards
// its dimmed end. Asserted through the animation calls rather than through the effect's own
// bookkeeping, so a change that stops dimming while still setting the flag is caught.
function dimmed(w) {
  const id = byWindow.get(w);
  if (id === undefined) return false;
  const a = anims.get(id);
  return !!a && a.alive && a.dir === 'forward';
}

// A fresh context per load, because the effect declares top-level consts and a second run in the
// same one is a redeclaration rather than a second session.
// Every load is a new session: the signals are rebuilt so the instance from the section before is
// not still listening. They share one `effects` object, and two tilers writing over each other is
// a thing this repository has already paid for once.
function load() {
  reset();
  for (const k of ['windowAdded', 'windowClosed', 'desktopChanged',
                   'hasActiveFullScreenEffectChanged', 'colorPickerActiveChanged']) effects[k] = sig();
  effect.configChanged = sig();
  vm.runInContext(fs.readFileSync(EFFECT, 'utf8'), makeCtx(), { filename: EFFECT });
}

// A marker over `rect`, or parked when given nothing -- which is how the tiler says the selection
// is empty. Parked is 1x1 and off-screen; see Selection.qml for why it parks rather than unmaps.
function marker(rect) {
  return mkWin({
    caption: 'kosmic-selection', windowClass: ' ', normalWindow: true,
    geometry: rect || { x: -32000, y: -32000, width: 1, height: 1 },
  });
}
function move(w, rect) { w.geometry = rect; w.windowFrameGeometryChanged.emit(w); }
function place(...list) { effects.stackingOrder = list; }

const SLOT_A = { x: 8, y: 40, width: 788, height: 952 };
const SLOT_B = { x: 804, y: 40, width: 788, height: 472 };
const SLOT_C = { x: 804, y: 520, width: 788, height: 472 };

// ---------- 1. the ordinary case ----------
{
  const m = marker(SLOT_A);
  const a = mkWin({ geometry: SLOT_A });
  const b = mkWin({ geometry: SLOT_B });
  place(m, a, b);
  load();

  assert.ok(!dimmed(a), 'the selected window is lit');
  assert.ok(dimmed(b), 'everything else is dimmed');
  assert.ok(!dimmed(m), 'and the marker itself is never dimmed');

  // The numbers, which are the whole of what the user sees. Brightness carries the dimming and
  // saturation follows at half the rate.
  const anim = anims.get(byWindow.get(b));
  const to = {};
  for (const x of anim.animations) to[x.type] = x.to;
  assert.equal(to[Effect.Brightness], 0.7, 'brightness is 1 - strength/100');
  assert.equal(to[Effect.Saturation], 0.85, 'saturation is 1 - strength/200');
  assert.equal(anim.duration, 250, 'and the fade takes the configured time');
}
console.log('1 ordinary case: ok');

// ---------- 2. the selection follows the marker ----------
{
  const m = marker(SLOT_A);
  const a = mkWin({ geometry: SLOT_A });
  const b = mkWin({ geometry: SLOT_B });
  place(m, a, b);
  load();

  move(m, SLOT_B);
  assert.ok(dimmed(a), 'the window that lost the selection dims');
  assert.ok(!dimmed(b), 'and the one that gained it lights up');
}
console.log('2 marker moves: ok');

// ---------- 3. a selected group lights all of it ----------
//
// The reason KWin's own diminactive cannot do this job. Focus(Out) selects the group around the
// focused window without changing which window is active, and the next resize or move applies to
// the whole group; diminactive reads effects.activeWindow and would light exactly one of them.
{
  const group = { x: 804, y: 40, width: 788, height: 952 };
  const m = marker(group);
  const a = mkWin({ geometry: SLOT_A });
  const b = mkWin({ geometry: SLOT_B });
  const c = mkWin({ geometry: SLOT_C });
  place(m, a, b, c);
  load();

  assert.ok(!dimmed(b) && !dimmed(c), 'every window in the selected group is lit');
  assert.ok(dimmed(a), 'and the one outside it is not');
}
console.log('3 group selection: ok');

// ---------- 4. no selection dims nothing ----------
//
// Not "dims everything", which is what a reader that only tested for overlap would do: a parked
// marker overlaps nothing at all.
{
  const m = marker(SLOT_A);
  const a = mkWin({ geometry: SLOT_A });
  const b = mkWin({ geometry: SLOT_B });
  place(m, a, b);
  load();
  assert.ok(dimmed(b), 'dimmed to begin with');

  move(m, { x: -32000, y: -32000, width: 1, height: 1 });
  assert.ok(!dimmed(a) && !dimmed(b), 'a parked marker lights the whole screen');

  // And parked at its full size, which is what a PlasmaCore.Dialog clamping itself to a minimum
  // would look like. The size test alone would read this as a selection covering nothing at all,
  // and dim every window on the screen -- the one failure this effect must not have.
  move(m, SLOT_A);
  assert.ok(dimmed(b), 'a real selection dims again');
  move(m, { x: -32000, y: -32000, width: 788, height: 952 });
  assert.ok(!dimmed(a) && !dimmed(b), 'parked at full size is still parked');
}
console.log('4 parked marker: ok');

// ---------- 5. the marker going away lights everything ----------
//
// The failsafe, and the only part of the effect that is not cosmetic. `set` holds its end value
// for as long as the window lives, so a tiler that has crashed or been unloaded would otherwise
// leave the screen dark with nothing running that could undo it.
{
  const m = marker(SLOT_A);
  const a = mkWin({ geometry: SLOT_A });
  const b = mkWin({ geometry: SLOT_B });
  place(m, a, b);
  load();
  assert.ok(dimmed(b), 'dimmed to begin with');

  m.deleted = true;
  place(a, b);
  effects.windowClosed.emit(m);
  assert.ok(!dimmed(a) && !dimmed(b), 'the marker closing lights everything back up');
}
console.log('5 marker closed: ok');

// ---------- 6. a window that spilled out of its slot ----------
//
// A KWin client can refuse a size, and one that refuses is drawn over its neighbour. The tiler
// hands over the union of the slot and what the window actually took, so the test here is half of
// the window's *own* area: containment would dim the window that spilled, and bare intersection
// would light the neighbour it spilled onto.
{
  const slot = { x: 8, y: 40, width: 500, height: 400 };
  const spilled = { x: 8, y: 40, width: 720, height: 400 };
  const neighbour = { x: 516, y: 40, width: 500, height: 400 };
  const m = marker({ x: 8, y: 40, width: 720, height: 400 });   // the union the tiler sends
  const a = mkWin({ geometry: spilled });
  const b = mkWin({ geometry: neighbour });
  place(m, a, b);
  load();

  assert.ok(!dimmed(a), 'the window that spilled is still the selected one');
  assert.ok(dimmed(b), 'the neighbour it landed on is not selected by being underneath it');
  void slot;
}
console.log('6 overflow: ok');

// ---------- 7. the other monitor stays lit ----------
//
// The selection lives on one output, so every window on the other one has no overlap with it and
// the overlap rule alone would darken a whole screen the user is reading.
{
  const m = marker(SLOT_A);
  const a = mkWin({ geometry: SLOT_A });
  const far = mkWin({ geometry: { x: 2000, y: 40, width: 788, height: 952 }, screen: OTHER });
  place(m, a, far);
  load();

  assert.ok(!dimmed(a), 'the selected window is lit');
  assert.ok(!dimmed(far), 'and so is everything on the other output');
}
console.log('7 second monitor: ok');

// ---------- 8. what is not a tile is not dimmed ----------
//
// The panel, the desktop and -- the case this effect exists for -- a menu. The outline was
// replaced because a menu could not be drawn over it; dimming the menu along with the window that
// opened it would be the same failure wearing different clothes.
{
  const m = marker(SLOT_A);
  const a = mkWin({ geometry: SLOT_A });
  const b = mkWin({ geometry: SLOT_B });
  const menu = mkWin({ geometry: { x: 850, y: 90, width: 300, height: 400 }, popupWindow: true, normalWindow: false });
  const panel = mkWin({ geometry: { x: 0, y: 0, width: 1600, height: 32 }, dock: true, normalWindow: false });
  const desktop = mkWin({ geometry: { x: 0, y: 0, width: 1600, height: 1000 }, desktopWindow: true, normalWindow: false });
  const zone = mkWin({ geometry: SLOT_C, caption: 'kosmic-dropzone', windowClass: ' ' });
  const elsewhere = mkWin({ geometry: SLOT_C, onCurrentDesktop: false });
  const hidden = mkWin({ geometry: SLOT_C, visible: false });
  place(m, a, b, menu, panel, desktop, zone, elsewhere, hidden);
  load();

  assert.ok(dimmed(b), 'an unselected tile is dimmed');
  assert.ok(!dimmed(menu), 'a menu over a dimmed window keeps its own colours');
  assert.ok(!dimmed(panel), 'the panel is not part of the layout');
  assert.ok(!dimmed(desktop), 'nor is the desktop');
  assert.ok(!dimmed(zone), 'the drop zone says where a window is going and is left alone');
  assert.ok(!dimmed(elsewhere), 'a window on another desktop is not on this screen to dim');
  assert.ok(!dimmed(hidden), 'and neither is one that is not mapped');
}
console.log('8 exclusions: ok');

// ---------- 9. a tab bar dims with the slot it belongs to ----------
//
// It is the top of the stack's slot, standing in for the title bar the stacked windows gave up.
// Left lit over a dimmed stack it reads as a separate, brighter thing sitting on the window.
//
// The two bars here are given the window types that would otherwise exclude them, because what
// KWin calls one of our dialogs is not ours to choose: libplasma rewrites the type, and the
// geometry animation already records finding the old outline reported as a Notification when it
// had been built as an OnScreenDisplay. The caption is the only thing about these windows this
// module sets, so the caption is what has to decide.
{
  const m = marker(SLOT_A);
  const mine = mkWin({ geometry: { x: 8, y: 40, width: 788, height: 28 }, caption: 'kosmic-tabbar',
                      windowClass: ' ', onScreenDisplay: true });
  const theirs = mkWin({ geometry: { x: 804, y: 40, width: 788, height: 28 }, caption: 'kosmic-tabbar',
                        windowClass: ' ', notification: true, normalWindow: false });
  place(m, mine, theirs);
  load();

  assert.ok(!dimmed(mine), 'the selected stack keeps its bar lit');
  assert.ok(dimmed(theirs), 'and an unselected stack dims its bar with it');
}
console.log('9 tab bars: ok');

// ---------- 10. somebody else drawing the screen ----------
{
  const m = marker(SLOT_A);
  const a = mkWin({ geometry: SLOT_A });
  const b = mkWin({ geometry: SLOT_B });
  place(m, a, b);
  load();
  assert.ok(dimmed(b), 'dimmed to begin with');

  // The overview and the grid paint every window as a thumbnail; half of them dark is noise.
  effects.hasActiveFullScreenEffect = true;
  effects.hasActiveFullScreenEffectChanged.emit();
  assert.ok(!dimmed(b), 'a full screen effect takes the dimming off');
  effects.hasActiveFullScreenEffect = false;
  effects.hasActiveFullScreenEffectChanged.emit();
  assert.ok(dimmed(b), 'and gives it back');

  // A colour picker needs the colour that is actually on the screen.
  effects.colorPickerActive = true;
  effects.colorPickerActiveChanged.emit();
  assert.ok(!dimmed(b), 'so does a colour picker');
  effects.colorPickerActive = false;
  effects.colorPickerActiveChanged.emit();

  // A full screen window is the whole output: there is nothing beside it to dim, and the dimming
  // would land on the thing being watched.
  const film = mkWin({ geometry: { x: 0, y: 0, width: 1600, height: 1000 }, fullScreen: true });
  place(m, a, b, film);
  effects.windowAdded.emit(film);
  assert.ok(!dimmed(b), 'a full screen window on this output takes the dimming off');

  // On the other output it changes nothing here.
  film.screen = OTHER;
  film.windowFullScreenChanged.emit(film);
  assert.ok(dimmed(b), 'full screen on the other monitor leaves this one alone');
}
console.log('10 inhibited: ok');

// ---------- 11. a settled screen is left alone ----------
//
// refresh() runs on every geometry write the tiler makes, which during one layout pass is one per
// window and over a correction loop is that again every second. A window whose state has not
// changed must be touched not at all: no new animation, and no redirect of the one it has. The
// redirect is the half that is easy to lose, because losing it costs nothing visible -- it is a
// call per window per refresh that the screen never shows, which is how it would survive review.
{
  const m = marker(SLOT_A);
  const a = mkWin({ geometry: SLOT_A });
  const b = mkWin({ geometry: SLOT_B });
  place(m, a, b);
  load();
  const after = sets;
  redirects = 0;

  for (let i = 0; i < 20; i++) {
    a.windowFrameGeometryChanged.emit(a);
    b.windowFrameGeometryChanged.emit(b);
    effects.desktopChanged.emit();
  }
  assert.equal(sets, after, 'nothing restarted: ' + sets + ' animations, was ' + after);
  assert.equal(redirects, 0, 'and nothing was redirected either: ' + redirects);
}
console.log('11 idempotent: ok');

// ---------- 12. the strength is read back on reconfigure ----------
//
// The number is meant to be tuned by hand against a live session -- kwriteconfig6 then
// `qdbus6 org.kde.KWin /KWin reconfigure` -- so it has to take effect without a restart.
{
  const m = marker(SLOT_A);
  const a = mkWin({ geometry: SLOT_A });
  const b = mkWin({ geometry: SLOT_B });
  place(m, a, b);
  load();

  config = { Strength: 60, Duration: 250, Debug: false };
  effect.configChanged.emit();
  const to = {};
  for (const x of anims.get(byWindow.get(b)).animations) to[x.type] = x.to;
  assert.equal(to[Effect.Brightness], 0.4, 'the new strength is in the new animation');
  assert.ok(!dimmed(a), 'and the selected window is still lit');
  config = { Strength: 30, Duration: 250, Debug: false };
}
console.log('12 reconfigure: ok');

console.log('sim30 ok');
