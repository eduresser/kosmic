// The workspace list: created by being walked into, collected when nothing holds it.
//
// This was `kosmic-workspaces`, a plain `javascript` KWin script beside the tiler, and because a
// plain script is one file with no exports the simulator could not load it -- so the one piece of
// KOSMIC that removes things behind the user's back had no test at all. Folding it into the tiler
// is what makes this file possible; the rest of why is in "the workspace list" over there.
//
// Upstream (`Workspaces::ensure_last_empty`, cosmic-comp src/shell/mod.rs :694) keeps the active
// empty workspace and a trailing one for ever. Here only the active one survives: an empty
// workspace is made when it is walked into -- by the keys, or by the kosmic-swipe plugin for the
// touchpad -- and is collected once it is left. Once its slide has finished, which is the subtlety
// worth testing: removing a workspace mid-slide is what broke the animation once already.
import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };

const TILER = process.argv[2];
let nid = 0;

// A whole session, built fresh. Two are needed here because the policy is read once at startup --
// `readSettings` runs in main() and KWin gives a script no signal for its own configuration -- so
// the only way to test it switched off is to start another one. Node keys the module cache by URL,
// so the query string is what makes the second import a second instance rather than the first one
// again, with its module-level state still in it.
async function world(settings) {
  const out = { name: 'o1' };
  let dn = 0;
  const mkDesk = () => ({ id: 'd' + (++dn) });
  const desks = [mkDesk()];
  const wins = [];
  const removed = [];
  const logged = [];
  const sweep = { asked: 0 };

  function mkWin(cls, desk) {
    const w = {
      internalId: 'w' + (++nid), resourceClass: cls, caption: cls, normalWindow: true, transient: false,
      dialog: false, specialWindow: false, skipPager: false, onAllDesktops: false, icon: null, noBorder: false,
      desktops: [desk], output: out, moveable: true, resizeable: true, minimized: false,
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

  const ws = {
    windowAdded: sig(), windowRemoved: sig(), windowActivated: sig(), currentDesktopChanged: sig(),
    desktops: desks, currentDesktop: desks[0], activeWindow: null, cursorPos: { x: 0, y: 0 },
    activeScreen: out,
    windowList: () => wins.slice(),
    clientArea: () => ({ x: 0, y: 32, width: 1600, height: 968 }),
    createDesktop(pos) { desks.splice(pos, 0, mkDesk()); },
    // Recorded as well as applied: counting desktops cannot tell "removed the right one" from
    // "removed one and made another".
    removeDesktop(d) { const i = desks.indexOf(d); if (i >= 0) { desks.splice(i, 1); removed.push(d.id); } },
  };
  const kw = { MaximizeArea: 1, readConfig: (k, d) => (k in settings ? settings[k] : d) };
  const ui = {
    activeMode: '', enforceTimer: { restart() {} }, osd: () => {},
    publishTiling: () => {},
    showSelection: () => true, hideSelection: () => {},
    newBar: () => ({ apply() {}, destroy() {}, visible: false }),
  };
  // main.qml's, which waits for KWin's slide to finish; slideEnds() below is the slide finishing.
  ui.sweepWhenIdle = () => { sweep.asked++; };

  const P = await import(TILER + '?world=' + (++worldSeq));
  P.main({ workspace: ws, kwin: kw }, { root: ui, dbg: (m) => logged.push(String(m)) });

  return {
    P, ws, desks, removed, logged,
    at: (i) => desks[i],
    open(cls) {
      const w = mkWin(cls, ws.currentDesktop);
      wins.push(w);
      ws.windowAdded.emit(w);
      ws.activeWindow = w;
      ws.windowActivated.emit(w);
      return w;
    },
    close(w) { wins.splice(wins.indexOf(w), 1); ws.windowRemoved.emit(w); },
    // The desktop switch KWin would announce. goWorkspace sets the property directly; the real
    // signal comes from KWin watching it.
    announce() { ws.currentDesktopChanged.emit(); },
    // A keyed switch run to the end: the action, KWin's signal, the slide finishing.
    go(name) { P.action(name); ws.currentDesktopChanged.emit(); this.slideEnds(); },
    // A switch KWin made on its own, the touchpad's swipe or the pager: the property changes and
    // the signal follows, with no action of the script's before it.
    swipeTo(d) { ws.currentDesktop = d; ws.currentDesktopChanged.emit(); },
    // What main.qml does once KWin no longer lists the slide as active.
    slideEnds() { assert.ok(sweep.asked > 0, 'a switch asked to be told when the slide ends'); sweep.asked = 0; P.sweepWorkspaces(); },
    sweep,
    // One `space` line per live space, which is the only way to see the map from outside.
    spaceKeys() {
      logged.length = 0;
      P.action('dump');
      return logged.join('\n').split('\n')
        .filter((l) => l.startsWith('space '))
        .map((l) => l.slice('space '.length).split(' ')[0]);
    },
  };
}
let worldSeq = 0;

// ---------- walking creates ----------
const w = await world({});
const first = w.open('konsole');
assert.strictEqual(w.desks.length, 1, 'one desktop to start with, and no empty one waiting');

w.go('workspace-next');
assert.strictEqual(w.desks.length, 2, 'walking off the last occupied workspace makes one');
assert.strictEqual(w.ws.currentDesktop, w.at(1), 'and goes to it');

// ---------- and stops ----------
//
// Walking off the empty one again would mint a workspace per keypress.
w.go('workspace-next');
assert.strictEqual(w.desks.length, 2, 'walking off the empty one makes nothing');
assert.strictEqual(w.ws.currentDesktop, w.at(1), 'and stays put');

// ---------- the empty one goes once it is left, after the slide ----------
const ghost = w.at(1).id;
w.P.action('workspace-prev'); w.announce();
assert.strictEqual(w.ws.currentDesktop, w.at(0), 'walking back goes back');
assert.strictEqual(w.desks.length, 2, 'the empty one is still there while the slide runs');
w.slideEnds();
assert.deepStrictEqual(w.removed, [ghost], 'and gone once it has finished');
assert.strictEqual(w.desks.length, 1, 'leaving the occupied one alone in the list');

// ---------- the same at the front ----------
w.go('workspace-prev');
assert.strictEqual(w.desks.length, 2, 'walking off the front makes one there');
assert.strictEqual(w.ws.currentDesktop, w.at(0), 'and goes to it');
w.go('workspace-next');
assert.strictEqual(w.desks.length, 1, 'which goes once it is left');
assert.strictEqual(w.at(0), first.desktops[0], 'the occupied one is first again');

// ---------- an empty one in the middle does not survive ----------
w.go('workspace-next');
const middle = w.open('firefox');
const middleId = w.ws.currentDesktop.id;
w.go('workspace-next');
const far = w.open('dolphin');
w.go('workspace-prev'); w.go('workspace-prev');
assert.strictEqual(w.desks.length, 3, 'three workspaces');
w.removed.length = 0;
w.close(middle);
assert.strictEqual(w.desks.length, 2, 'emptying the middle workspace removes it');
assert.deepStrictEqual(w.removed, [middleId], 'and removes that one');

// ---------- the active one never goes ----------
//
// Standing on a workspace and closing its last window leaves it there. Removing the workspace out
// from under the user is the one thing this policy must not do.
w.go('workspace-next');
const standingOn = w.ws.currentDesktop;
w.close(far);
assert.ok(w.desks.includes(standingOn), 'the workspace being stood on is never removed');

// ---------- the last workspace ----------
//
// Upstream's last workspace is the empty one past the end. Here it is made when asked for.
const l = await world({});
const lOnly = l.open('konsole');
l.go('workspace-last');
assert.strictEqual(l.desks.length, 2, 'going to the last workspace makes the empty one past the end');
assert.strictEqual(l.ws.currentDesktop, l.at(1), 'and goes to it');
l.go('workspace-last');
assert.strictEqual(l.desks.length, 2, 'standing on it, asking again makes nothing');
l.go('workspace-prev');
l.open('kate');
l.ws.activeWindow = lOnly;
l.P.action('workspace-move-last'); l.announce(); l.slideEnds();
assert.strictEqual(lOnly.desktops[0], l.at(1), 'moving a window there takes it to a new workspace');
l.P.action('workspace-move-last'); l.announce(); l.slideEnds();
assert.strictEqual(l.desks.length, 2, 'and moving it again, alone on the last one, makes nothing');

// ---------- a space whose desktop is gone is dropped ----------
//
// A space is keyed by (output, desktop), and an empty one whose tiling flag differs from the
// default is deliberately kept -- that is what makes the applet's switch work on an empty
// workspace. Which means a removed desktop leaves a space that can never be reached and never be
// collected. Nothing but this code can notice: it is the only thing that knows a desktop went.
const v = await world({});
const vFirst = v.open('konsole');
v.go('workspace-next');                  // a new, empty one
const doomed = v.ws.currentDesktop.id;
v.P.action('tiling');                    // it carries a decision now, so it is kept while empty
assert.ok(v.spaceKeys().some((k) => k.endsWith('|' + doomed)),
          'the empty workspace has a space of its own');

v.open('kate');                          // make it real
v.go('workspace-next');
const held = v.open('dolphin');          // and one past it, so it is in the middle
v.go('workspace-prev'); v.go('workspace-prev');   // stand on the first, so the doomed one is neither
for (const win of v.ws.windowList()) {
  if (win.desktops[0] && win.desktops[0].id === doomed) v.close(win);
}
assert.ok(!v.desks.some((d) => d.id === doomed), 'the emptied middle workspace is removed');
assert.ok(!v.spaceKeys().some((k) => k.endsWith('|' + doomed)),
          'and its space goes with it');
// Nothing else was taken: the workspaces that still exist still have theirs.
for (const k of v.spaceKeys()) {
  const id = k.slice(k.lastIndexOf('|') + 1);
  assert.ok(v.desks.some((d) => d.id === id), 'space ' + k + ' names a desktop that is still there');
}
assert.ok(vFirst && held, 'the windows that held the other two are still open');

// ---------- moving a window does not mint a workspace for it alone ----------
//
// The window being moved is the only thing holding its workspace, so walking it right would empty
// one workspace and make another -- a workspace per keypress.
const x = await world({});
const only = x.open('konsole');
x.P.action('workspace-right');
assert.strictEqual(x.desks.length, 1, 'moving the only window right mints nothing');
assert.strictEqual(only.desktops[0], x.at(0), 'and leaves it where it was');

// ---------- switched off ----------
//
// DynamicWorkspaces=false in [Script-kosmic-tiling]. The keys stay bound and step through the desktops
// KDE already has; nothing is minted and nothing is collected. Leaving them unbound instead would
// hand the chords back to nothing, since the module takes the KDE defaults that collide with them.
const off = await world({ DynamicWorkspaces: 'false' });
off.open('konsole');
off.P.action('workspace-next');
assert.strictEqual(off.desks.length, 1, 'with the policy off, walking off the end makes nothing');
off.ws.createDesktop(1);
off.P.action('workspace-next');
assert.strictEqual(off.ws.currentDesktop, off.at(1), 'the keys still step through what KDE has');
off.P.action('workspace-prev');
off.announce();
assert.strictEqual(off.ws.currentDesktop, off.at(0), 'in both directions');
assert.deepStrictEqual(off.removed, [], 'and the empty one is left alone');

// ---------- collected once the slide is over, however the switch was made ----------
//
// The touchpad's swipe is KWin's own: the script hears of it only through currentDesktopChanged,
// after the switch, so the collection that runs before a keyed switch never ran for it and an
// emptied workspace stayed in the list. Every switch now asks to be told when the slide is over,
// and collects then. Not before: a removal mid-slide collapses the grid the effect is reading.
const g = await world({});
g.open('konsole');
g.go('workspace-next');
const gTwo = g.open('firefox'); const gTwoId = g.ws.currentDesktop.id;
g.go('workspace-next');
g.open('dolphin');
g.swipeTo(g.at(1)); g.slideEnds();
g.close(gTwo);
assert.strictEqual(g.desks.length, 3, 'the emptied workspace being stood on stays');
g.swipeTo(g.at(0));
assert.strictEqual(g.sweep.asked, 1, 'the swipe asks to be told when its slide ends');
assert.strictEqual(g.desks.length, 3, 'nothing is removed while the slide runs');
g.close(g.open('kate'));
assert.strictEqual(g.desks.length, 3, 'not even by a window closing mid-slide');
g.slideEnds();
assert.deepStrictEqual(g.removed, [gTwoId], 'once it ends the emptied workspace is gone');
assert.strictEqual(g.desks.length, 2, 'leaving the two that hold windows');

// A swipe past the end, as kosmic-swipe makes it: the workspace appears, the swipe lands on it, and
// it stays while stood on and goes once left.
g.ws.createDesktop(g.desks.length);
const swiped = g.at(2);
g.swipeTo(swiped); g.slideEnds();
assert.ok(g.desks.includes(swiped), 'the workspace the swipe made stays while it is stood on');
g.swipeTo(g.at(1)); g.slideEnds();
assert.ok(!g.desks.includes(swiped), 'and goes once the swipe has left it');

// A key pressed before the slide is over walks into the workspace just left, still listed, rather
// than removing it and going past it.
const k = await world({});
k.open('konsole');
k.go('workspace-next');
const kTwo = k.open('firefox');
k.go('workspace-next');
k.open('dolphin');
k.swipeTo(k.at(1)); k.slideEnds();
k.close(kTwo);
k.P.action('workspace-prev'); k.announce();
k.P.action('workspace-next'); k.announce();
assert.strictEqual(k.ws.currentDesktop, k.at(1), 'back on the emptied workspace');
k.slideEnds();
assert.strictEqual(k.desks.length, 3, 'which stays, because it is being stood on again');
k.go('workspace-prev');
assert.strictEqual(k.desks.length, 2, 'and goes once it is left for good');

// With the policy off a switch waits for nothing, because there is nothing to collect.
const gOff = await world({ DynamicWorkspaces: 'false' });
gOff.ws.createDesktop(1);
gOff.swipeTo(gOff.at(1));
assert.strictEqual(gOff.sweep.asked, 0, 'with the policy off a switch does not wait for the slide');

console.log('sim33 ok');
