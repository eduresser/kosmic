// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// Super+Shift+direction: rearrange inside the tree, cross to the neighbouring workspace only at the edge.
import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };
const out = { name: 'o1' };
let dn = 0;
const mkDesk = () => ({ id: 'd' + (++dn) });
const desks = [mkDesk()];
let nid = 0;
function mkWin(cls) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, normalWindow: true, transient: false, dialog: false, specialWindow: false,
    desktops: [ws.currentDesktop], output: out, moveable: true, resizeable: true, minimized: false, fullScreen: false, move: false, resize: false,
    skipPager: false, maximizeMode: 0, tile: null,
    _g: { x: 100, y: 100, width: 500, height: 400 },
    minimizedChanged: sig(), fullScreenChanged: sig(), desktopsChanged: sig(), outputChanged: sig(), frameGeometryChanged: sig(),
    interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(), maximizedChanged: sig(),
    setMaximize(v, h) { w.maximizeMode = (v && h) ? 3 : 0; w.maximizedChanged.emit(); },
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
  desktops: desks, currentDesktop: desks[0], activeWindow: null, cursorPos: { x: 0, y: 0 },
  windowList: () => wins.slice(),
  clientArea: () => ({ x: 0, y: 32, width: 1600, height: 968 }),
  createDesktop(pos) { desks.splice(pos, 0, mkDesk()); },
  removeDesktop(d) { const i = desks.indexOf(d); if (i >= 0) desks.splice(i, 1); },
};
const kw = { MaximizeArea: 1 };
const ui = { activeMode: "", enforceTimer: { restart() {} } };
const P = await import(process.argv[2]);
P.main({ workspace: ws, kwin: kw }, { root: ui, dbg: () => {} });

function open(cls) {
  const w = mkWin(cls); wins.push(w);
  ws.windowAdded.emit(w);
  ws.activeWindow = w; ws.windowActivated.emit(w);
  return w;
}
const focus = (w) => { ws.activeWindow = w; ws.windowActivated.emit(w); };
const show = (list) => list.map((w) => `${w.resourceClass}[${Math.round(w._g.x)},${Math.round(w._g.y)} ${Math.round(w._g.width)}x${Math.round(w._g.height)}]`).join('  ');
const deskOf = (w) => w.desktops[0].id;

// 1. two windows side by side: moving left swaps them inside the fork, the workspace stays the same
const a = open('a'), b = open('b');
assert.ok(a._g.x < b._g.x, 'a left of b: ' + show([a, b]));
focus(b);
P.action('window-left');
console.log('1 after window-left:', show([a, b]));
assert.ok(b._g.x < a._g.x, 'b moved to the left half');
assert.equal(desks.length, 1, 'no workspace was created');
assert.equal(deskOf(b), deskOf(a), 'both still on the same workspace');

// 2. vertical: c opens next to the focused b, giving (b over c) | a; moving up swaps b and c
const c = open('c');
console.log('2 three windows:', show([b, c, a]));
assert.ok(b._g.y < c._g.y && b._g.x < a._g.x, 'b above c on the left half');
focus(c);
P.action('window-up');
console.log('2 after window-up:', show([b, c, a]));
assert.ok(c._g.y < b._g.y, 'c moved above b');
assert.equal(desks.length, 1, 'no workspace was created');

// 3. nothing above inside the column: the window leaves it and takes the whole top row. From there
//    up has nowhere left to go, and there is no workspace in that direction either.
P.action('window-up');
console.log('3 after window-up out of the column:', show([c, b, a]));
assert.equal(Math.round(c._g.width), 1584, 'c took the top row');
assert.ok(b._g.y > c._g.y && a._g.y > c._g.y, 'b and a share the row below');
const before = show([b, c, a]);
P.action('window-up');
console.log('3 after window-up at the edge:', show([b, c, a]));
assert.equal(show([b, c, a]), before, 'layout unchanged');
assert.equal(desks.length, 1, 'no workspace was created');

// 4. at the left edge the window leaves for a new workspace and the others fill the gap
focus(c);
P.action('window-left');        // out of the row: c takes the left half
P.action('window-left');        // now really at the left edge
console.log('4 after window-left at the edge: desktops=' + desks.length, show([b, c, a]));
assert.equal(desks.length, 2, 'a workspace was created to the left');
assert.equal(deskOf(c), desks[0].id, 'c is on the new workspace');
assert.notEqual(deskOf(b), deskOf(c), 'b stayed behind');
assert.equal(ws.currentDesktop.id, desks[0].id, 'the view followed the window');
assert.equal(c._g.x, 8, 'c is alone and fills its workspace: ' + show([c]));

// 5. alone on its workspace, the window does not create yet another one
P.action('window-left');
console.log('5 alone at the edge: desktops=' + desks.length);
assert.equal(desks.length, 2, 'no extra workspace');

// 6. crossing into a workspace that already has windows: the window lands on the edge it came from.
//    Moving left it arrives from the right, so it takes the right side (COSMIC map_to_tree + direction).
// An empty workspace is collected the moment nothing holds it, so a is kept until the view has moved.
const other = desks[1];
ws.currentDesktop = other; ws.currentDesktopChanged.emit();
for (const w of [a, b]) { wins.splice(wins.indexOf(w), 1); ws.windowRemoved.emit(w); }
const d = open('d'), e = open('e');
console.log('6 other workspace:', show([d, e]));
assert.ok(d._g.x < e._g.x, 'd left of e');
focus(e);
P.action('window-left');          // swaps with d inside the tree
P.action('window-left');          // now at the left edge: leaves for the previous workspace
console.log('6 after crossing left:', show([c, e]), 'desktops=' + desks.length);
assert.equal(deskOf(e), deskOf(c), 'e joined c');
assert.ok(c._g.x < e._g.x, 'e took the right side: ' + show([c, e]));
assert.equal(Math.round(c._g.x), 8, 'c starts at the left gap');
assert.equal(Math.round(e._g.x + e._g.width), 1592, 'e ends at the right gap');

// 7. the other way round: crossing right lands on the left side of the next workspace
focus(e);
P.action('window-right');         // e is already at the right edge: leaves for the next workspace
console.log('7 after crossing right:', show([d, e]), 'desktops=' + desks.length);
assert.equal(deskOf(e), deskOf(d), 'e joined d');
assert.ok(e._g.x < d._g.x, 'e took the left side: ' + show([d, e]));
assert.equal(Math.round(e._g.x), 8, 'e starts at the left gap');
assert.equal(Math.round(d._g.x + d._g.width), 1592, 'd ends at the right gap');

console.log('OK sim5');
