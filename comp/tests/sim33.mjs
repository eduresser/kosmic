// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// The workspace list: created by being walked into, collected when nothing holds it.
//
// This was `kosmic-workspaces`, a plain `javascript` KWin script beside the tiler, and because a
// plain script is one file with no exports the simulator could not load it -- so the one piece of
// KOSMIC that removes things behind the user's back had no test at all. Folding it into the tiler
// is what makes this file possible; the rest of why is in "the workspace list" over there.
//
// The rule is upstream's `Workspaces::ensure_last_empty` (cosmic-comp src/shell/mod.rs :694), and
// the subtlety worth a test is which empty workspace survives: the active one, and the trailing
// one. The trailing empty workspace is the ghost walked into to make a new one, and deleting it
// the moment it is walked off is what broke the slide animation once already.
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
  const swept = { armed: false };

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
    activeMode: '', enforceTimer: { restart() {} }, sweepTimer: { restart() { swept.armed = true; } }, osd: () => {},
    publishTiling: () => {},
    showSelection: () => true, hideSelection: () => {},
    newBar: () => ({ apply() {}, destroy() {}, visible: false }),
  };

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
    // What sweepTimer does once the slide is over; it only fires if a switch armed it.
    sweep() { assert.ok(swept.armed, 'a desktop switch arms the sweep'); swept.armed = false; P.sweepWorkspaces(); },
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
w.open('konsole');
assert.strictEqual(w.desks.length, 1, 'one desktop to start with');

w.P.action('workspace-next');
assert.strictEqual(w.desks.length, 2, 'walking off the last occupied workspace makes one');
assert.strictEqual(w.ws.currentDesktop, w.at(1), 'and goes to it');

// ---------- and stops ----------
//
// The new one is the ghost: empty, and the end of the list. Walking off it again would mint a
// workspace per keypress.
w.P.action('workspace-next');
assert.strictEqual(w.desks.length, 2, 'walking off the empty ghost makes nothing');
assert.strictEqual(w.ws.currentDesktop, w.at(1), 'and stays put');

// ---------- the ghost survives being walked off ----------
//
// This is the clause worth the test. "Occupied plus the current one" would delete the ghost here,
// and that deletion is what collapsed the desktop grid under KWin's slide effect mid-animation --
// the window arrived from the wrong side. Upstream never deletes the trailing empty workspace.
w.P.action('workspace-prev');
w.announce();
assert.strictEqual(w.ws.currentDesktop, w.at(0), 'walking back goes back');
assert.strictEqual(w.desks.length, 2, 'the trailing empty workspace is still there while the slide runs');
w.sweep();
assert.strictEqual(w.desks.length, 1, 'and is collected once it has been left');

// ---------- an empty one in the middle does not ----------
//
// Three workspaces, the middle one emptied. It is neither active nor trailing, so it goes.
w.P.action('workspace-next');            // onto the ghost
const middle = w.open('firefox');        // which makes it real
const middleId = w.ws.currentDesktop.id;
w.P.action('workspace-next');            // and mints another past it
const far = w.open('dolphin');
w.P.action('workspace-prev');
w.P.action('workspace-prev');            // back to the first
w.announce();
assert.strictEqual(w.desks.length, 3, 'three workspaces');

w.close(middle);
assert.strictEqual(w.desks.length, 2, 'emptying the middle workspace removes it');
assert.strictEqual(w.removed[w.removed.length - 1], middleId, 'and removes that one');

// ---------- an empty workspace goes the moment it is left ----------
//
// Open on 1, 2 and 3, close everything on 2 while standing on it, and walk to 1. The empty 2 must
// be gone from the list once the slide has finished, not one more switch later. It has to wait for
// the slide, which is why it is a timer and not part of the switch.
const y = await world({});
y.open('konsole');
y.P.action('workspace-next'); y.announce();
const two = y.open('firefox'); const twoId = y.ws.currentDesktop.id;
y.P.action('workspace-next'); y.announce();
y.open('dolphin');
y.P.action('workspace-prev'); y.announce();
y.close(two);
assert.strictEqual(y.desks.length, 3, 'standing on the emptied workspace keeps it');
y.P.action('workspace-prev'); y.announce();
assert.strictEqual(y.desks.length, 3, 'it is still there while the slide runs');
y.sweep();
assert.deepStrictEqual(y.removed, [twoId], 'once the slide is over the emptied workspace is gone');
assert.strictEqual(y.desks.length, 2, 'leaving two');

// A minimized window still holds its workspace. Upstream does not count it (Workspace::windows()
// is the floating and tiling layers only), but removing the workspace would strand the window.
const z = await world({});
z.open('konsole');
z.P.action('workspace-next'); z.announce();
const mini = z.open('firefox'); mini.minimized = true;
z.P.action('workspace-next'); z.announce();
z.open('dolphin');
z.P.action('workspace-prev'); z.announce();
z.P.action('workspace-prev'); z.announce();
z.sweep();
assert.strictEqual(z.desks.length, 3, 'a workspace holding only a minimized window is kept');

// ---------- the active one never goes ----------
//
// Standing on a workspace and closing its last window leaves it there. Removing the workspace out
// from under the user is the one thing this policy must not do.
w.P.action('workspace-next');
w.announce();
const standingOn = w.ws.currentDesktop;
w.close(far);
assert.ok(w.desks.includes(standingOn), 'the workspace being stood on is never removed');

// ---------- a space whose desktop is gone is dropped ----------
//
// A space is keyed by (output, desktop), and an empty one whose tiling flag differs from the
// default is deliberately kept -- that is what makes the applet's switch work on an empty
// workspace. Which means a removed desktop leaves a space that can never be reached and never be
// collected. Nothing but this code can notice: it is the only thing that knows a desktop went.
const v = await world({});
const first = v.open('konsole');
v.P.action('workspace-next');            // ghost, empty
const doomed = v.ws.currentDesktop.id;
v.P.action('tiling');                    // it carries a decision now, so it is kept while empty
assert.ok(v.spaceKeys().some((k) => k.endsWith('|' + doomed)),
          'the empty workspace has a space of its own');

v.open('kate');                          // make it real so there is something past it
v.P.action('workspace-next');            // a new ghost at the end
const held = v.open('dolphin');          // and make that real too, so it is not the trailing empty
v.P.action('workspace-prev');
v.P.action('workspace-prev');            // stand on the first, so the middle one is neither
v.announce();
for (const win of v.ws.windowList()) {
  if (win.desktops[0] && win.desktops[0].id === doomed) v.close(win);
}
assert.ok(!v.desks.some((d) => d.id === doomed), 'the emptied middle workspace is removed');
assert.ok(!v.spaceKeys().some((k) => k.endsWith('|' + doomed)),
          'and its space goes with it');
// Nothing else was taken: the two workspaces that still exist still have theirs.
for (const k of v.spaceKeys()) {
  const id = k.slice(k.lastIndexOf('|') + 1);
  assert.ok(v.desks.some((d) => d.id === id), 'space ' + k + ' names a desktop that is still there');
}
assert.ok(first && held, 'the windows that held the other two are still open');

// ---------- moving a window does not mint a workspace for it alone ----------
//
// The `alone` rule, which used to be a second copy of occupied() in a file that could not see the
// first. The window being moved is the only thing holding its workspace, so walking it right would
// empty one workspace and make another -- a workspace per keypress again.
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

console.log('sim33 ok');
