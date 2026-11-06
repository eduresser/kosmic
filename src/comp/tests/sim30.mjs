// focusdim runs in its own JS engine and reads the selection from a dialog captioned "kosmic-selection".
// Node is laxer than QJSEngine, so passing here does not prove main.js parses in KWin.
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

// Resolved beside the tiler under test, so an extracted copy tests its own effect.
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

// set/redirect/cancel are the same three calls KWin's in-tree dialogparent effect uses.
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

// Read from the animation calls, not the effect's bookkeeping, so a flag set without dimming is caught.
function dimmed(w) {
  const id = byWindow.get(w);
  if (id === undefined) return false;
  const a = anims.get(id);
  return !!a && a.alive && a.dir === 'forward';
}

// A fresh context per load because the effect declares top-level consts; signals are rebuilt so the
// previous instance stops listening on the shared `effects` object.
function load() {
  reset();
  for (const k of ['windowAdded', 'windowClosed', 'desktopChanged',
                   'hasActiveFullScreenEffectChanged', 'colorPickerActiveChanged']) effects[k] = sig();
  effect.configChanged = sig();
  vm.runInContext(fs.readFileSync(EFFECT, 'utf8'), makeCtx(), { filename: EFFECT });
}

// Parked (1x1, off-screen) means no selection; see Selection.qml for why it parks rather than unmaps.
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

{
  const m = marker(SLOT_A);
  const a = mkWin({ geometry: SLOT_A });
  const b = mkWin({ geometry: SLOT_B });
  place(m, a, b);
  load();

  assert.ok(!dimmed(a), 'the selected window is lit');
  assert.ok(dimmed(b), 'everything else is dimmed');
  assert.ok(!dimmed(m), 'and the marker itself is never dimmed');

  const anim = anims.get(byWindow.get(b));
  const to = {};
  for (const x of anim.animations) to[x.type] = x.to;
  assert.equal(to[Effect.Brightness], 0.7, 'brightness is 1 - strength/100');
  assert.equal(to[Effect.Saturation], 0.85, 'saturation is 1 - strength/200');
  assert.equal(anim.duration, 250, 'and the fade takes the configured time');
}
console.log('1 ordinary case: ok');

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

// KWin's diminactive reads activeWindow and would light only one window of a selected group.
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

// A parked marker overlaps nothing, so a reader testing only for overlap would dim everything.
{
  const m = marker(SLOT_A);
  const a = mkWin({ geometry: SLOT_A });
  const b = mkWin({ geometry: SLOT_B });
  place(m, a, b);
  load();
  assert.ok(dimmed(b), 'dimmed to begin with');

  move(m, { x: -32000, y: -32000, width: 1, height: 1 });
  assert.ok(!dimmed(a) && !dimmed(b), 'a parked marker lights the whole screen');

  // A PlasmaCore.Dialog may clamp itself to a minimum size; a size-only test would then dim everything.
  move(m, SLOT_A);
  assert.ok(dimmed(b), 'a real selection dims again');
  move(m, { x: -32000, y: -32000, width: 788, height: 952 });
  assert.ok(!dimmed(a) && !dimmed(b), 'parked at full size is still parked');
}
console.log('4 parked marker: ok');

// Failsafe: `set` holds its end value while the window lives, so a dead tiler would leave the screen dark.
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

// The tiler sends the slot/window union; the test is half the window's own area, since containment
// would dim the spiller and bare intersection would light its neighbour.
{
  const slot = { x: 8, y: 40, width: 500, height: 400 };
  const spilled = { x: 8, y: 40, width: 720, height: 400 };
  const neighbour = { x: 516, y: 40, width: 500, height: 400 };
  const m = marker({ x: 8, y: 40, width: 720, height: 400 });
  const a = mkWin({ geometry: spilled });
  const b = mkWin({ geometry: neighbour });
  place(m, a, b);
  load();

  assert.ok(!dimmed(a), 'the window that spilled is still the selected one');
  assert.ok(dimmed(b), 'the neighbour it landed on is not selected by being underneath it');
  void slot;
}
console.log('6 overflow: ok');

// The overlap rule alone would darken the whole other output.
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

// Menus are why the effect replaced the outline; dimming them would be the same failure.
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

// libplasma rewrites our dialogs' window types, so only the caption the module sets can identify a tab bar.
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

  // Nothing beside a full screen window to dim, and the dimming would land on what is being watched.
  const film = mkWin({ geometry: { x: 0, y: 0, width: 1600, height: 1000 }, fullScreen: true });
  place(m, a, b, film);
  effects.windowAdded.emit(film);
  assert.ok(!dimmed(b), 'a full screen window on this output takes the dimming off');

  film.screen = OTHER;
  film.windowFullScreenChanged.emit(film);
  assert.ok(dimmed(b), 'full screen on the other monitor leaves this one alone');
}
console.log('10 inhibited: ok');

// refresh() runs on every geometry write; a redundant redirect is invisible, which is how it would survive review.
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

// Tuned live with kwriteconfig6 and `qdbus6 org.kde.KWin /KWin reconfigure`, so it must apply without a restart.
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
