// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// Moving the pointer from one drop zone to another lays out the WHOLE tree, not the subtree the
// detach and attach touched. The screen is still showing the shape of the previous zone, which
// differs everywhere, so laying out part of it leaves empty slots at both ends of the move.
import assert from 'node:assert';
let FAKE_T = 0; Date.now = () => FAKE_T;
globalThis.Qt = { rect: (x, y, w, h) => ({ x, y, width: w, height: h }) };
const sig = () => { const h = []; return { connect: (f) => h.push(f), emit: (...a) => h.forEach((f) => f(...a)) }; };
const desk = { id: 'd1' };
const out = { name: 'o1' };
let nid = 0;
function mkWin(cls, minW = 0, minH = 0) {
  const w = {
    internalId: 'w' + (++nid), resourceClass: cls, caption: cls + ' — title', normalWindow: true, transient: false,
    dialog: false, specialWindow: false, icon: null, noBorder: false, closed: false,
    desktops: [desk], output: out, moveable: true, resizeable: true, minimized: false, fullScreen: false, move: false, resize: false,
    maximizeMode: 0, tile: null, minSize: { width: minW, height: minH },
    _g: { x: 100, y: 100, width: 500, height: 400 },
    minimizedChanged: sig(), fullScreenChanged: sig(), desktopsChanged: sig(), outputChanged: sig(), frameGeometryChanged: sig(),
    interactiveMoveResizeStarted: sig(), interactiveMoveResizeFinished: sig(), interactiveMoveResizeStepped: sig(), moveResizedChanged: sig(), maximizedChanged: sig(), captionChanged: sig(),
    setMaximize(v, h) { w.maximizeMode = (v && h) ? 3 : 0; w.maximizedChanged.emit(); },
    closeWindow() { w.closed = true; },
  };
  Object.defineProperty(w, 'frameGeometry', {
    configurable: true,
    get() { return w._g; },
    set(r) { w._g = { x: r.x, y: r.y, width: Math.max(r.width, minW), height: Math.max(r.height, minH) }; w.frameGeometryChanged.emit(); },
  });
  return w;
}
const wins = [];
const ws = {
  windowAdded: sig(), windowRemoved: sig(), windowActivated: sig(), currentDesktopChanged: sig(),
  currentDesktop: desk, activeWindow: null, cursorPos: { x: 0, y: 0 },
  windowList: () => wins.slice(),
  clientArea: () => ({ x: 0, y: 32, width: 1600, height: 968 }),
};
const kw = { MaximizeArea: 1 };
// Stands in for the PlasmaCore.Dialog the script creates per stack.
const bars = [];
const ui = {
  activeMode: "", enforceTimer: { restart() {} }, osd: () => {},
  newBar() {
    const o = {
      visible: false, destroyed: false, id: -1, rect: null, tabs: [], active: -1,
      apply(id, rect, tabs, active) { o.id = id; o.rect = rect; o.tabs = tabs; o.active = active; o.visible = true; },
      destroy() { o.destroyed = true; },
    };
    bars.push(o);
    return o;
  },
};
const P = await import(process.argv[2]);
P.main({ workspace: ws, kwin: kw }, { root: ui, dbg: () => {} });
ws.desktops = [desk];

const zones = [];
ui.dragTimer = { interval: 0, restart() {} };
ws.showOutline = (r) => zones.push(r);
ws.hideOutline = () => {};
const fire = () => P.dragCommit();

const g = (w) => w._g;
const geo = (w) => ({ ...w._g });
const show = (l) => l.map((w) => `${w.resourceClass}[${w._g.x},${w._g.y} ${w._g.width}x${w._g.height}]`).join(' ');
const settle = (n = 4) => { for (let i = 0; i < n; i++) { FAKE_T += 800; P.reconcile(); } };
function focus(w) { ws.activeWindow = w; ws.windowActivated.emit(w); return w; }
function open(cls) { const w = mkWin(cls); wins.push(w); ws.windowAdded.emit(w); focus(w); return w; }
const step = (w, r, fx, fy) => {
  ws.cursorPos = { x: Math.round(r.x + r.width * fx), y: Math.round(r.y + r.height * fy) };
  w.interactiveMoveResizeStepped.emit();
};
const over = (p, q) => Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x) > 1 &&
                       Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y) > 1;

const list = ['a', 'b', 'c', 'd', 'e'].map(open);
settle();
console.log('inicial:', show(list));
const dragged = list[0];
const others = list.slice(1);
focus(dragged);
dragged.interactiveMoveResizeStarted.emit();

// The thing to assert is what the eye sees: no empty space. The other windows plus the placeholder have
// to cover the whole tree area, give or take the gaps between them. Laying out only the subtree that
// detach and attach walked leaves the rest at the sizes the previous zone gave them, and the difference
// is a slot-sized hole -- at the place the window came from and at the place it is going to.
const AREA = { x: 8, y: 40, width: 1584, height: 952 };
function holes(rects) {
  const bad = [];
  for (let x = AREA.x + 6; x < AREA.x + AREA.width; x += 12) {
    for (let y = AREA.y + 6; y < AREA.y + AREA.height; y += 12) {
      let ok = false;
      for (const r of rects) {
        if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) { ok = true; break; }
        const dx = Math.max(r.x - x, x - (r.x + r.width), 0);
        const dy = Math.max(r.y - y, y - (r.y + r.height), 0);
        if (dx <= 10 && dy <= 10) { ok = true; break; }     // in a gap between slots
      }
      if (!ok) bad.push(x + ',' + y);
    }
  }
  return bad;
}

const visits = [[others[0], 0.05, 0.5], [others[1], 0.5, 0.95], [others[2], 0.95, 0.5],
                [others[3], 0.5, 0.05], [others[0], 0.95, 0.5]];
let commits = 0;
for (const [target, fx, fy] of visits) {
  const seen = zones.length;
  step(dragged, geo(target), fx, fy);
  fire();
  if (zones.length === seen) continue;             // same zone as before: nothing to check
  commits++;
  const placeholder = zones[zones.length - 1];
  const bad = holes([...others.map(g), placeholder]);
  console.log('zona:', JSON.stringify(placeholder), 'pontos descobertos:', bad.length, '|', show(others));
  assert.equal(bad.length, 0,
    `the whole tree must be laid out again for every zone: ${bad.length} points of the screen are ` +
    `covered by nothing, starting at ${bad[0]} -- ` + show(others));
  for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) {
    assert.ok(!over(g(others[i]), g(others[j])),
      `${others[i].resourceClass} and ${others[j].resourceClass} overlap: ` + show(others));
  }
}
assert.ok(commits >= 3, 'the walk should have gone through at least three zones, got ' + commits);

dragged.interactiveMoveResizeFinished.emit();
settle();
console.log('soltou:', show(list));
assert.equal(holes(list.map(g)).length, 0, 'and no empty space after the drop: ' + show(list));

console.log('sim16 ok');
