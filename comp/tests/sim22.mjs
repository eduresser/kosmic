// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// Drop zones and the drop itself: update_pointer_position :3386 and drop_window :2666.
//
// GroupInterior is the zone that forced the N-ary tree. On a binary fork there is no index to
// drop at — a row of five is nested forks, so "between the second and third" names nothing.
// Here it is a position in a size vector, and that is the whole reason this port happened.
//
// Also pinned down:
//   - the edge band is 32px to enter and 80px to leave, so the committed edge is stickier than
//     the one you are hovering; that hysteresis is what stops it flickering on the boundary
//   - the four bands are carved in order, so they are not symmetric strips and the corners
//     belong to whichever band was carved first
//   - the middle third in both axes stacks; outside it the split side is the nearest edge as a
//     *fraction* of the window, so shape does not bias the result
//   - the descent stops at a group holding a drop zone, which is what keeps a live layout from
//     chasing the pointer
//   - GroupInterior's index is clamped on drop, because the layout may have moved while the
//     pointer dwelled
//
import assert from 'node:assert';
import path from 'node:path';

const tiler = process.argv[2];
const core = await import(path.join(path.dirname(tiler), 'core.mjs'));
const {
    HORIZONTAL, VERTICAL, LEFT, RIGHT, UP, DOWN,
    newGroup, newMapped, newPlaceholder, addWindow, dataLen, isGroup, isMapped,
    node, appendChild, measure, preOrder,
    DROP_ZONE, GRABBED_WINDOW,
    EDGE_BAND, EDGE_BAND_HELD,
    MOUSE_ANIMATION_DELAY, INITIAL_MOUSE_ANIMATION_DELAY,
    ZONE_GROUP_EDGE, ZONE_GROUP_INTERIOR, ZONE_WINDOW_SPLIT, ZONE_WINDOW_STACK,
    ZONE_INITIAL_PLACEHOLDER,
    zoneAt, nodeUnder, dropWindow, dwellElapsed, zonesEqual,
} = core;

const sum = (a) => a.reduce((x, y) => x + y, 0);
const mk = (ref) => node(newMapped(ref));
const refs = (n) => n.children.map((c) => (isMapped(c.data) ? c.data.ref : '<group>'));
const AREA = { x: 0, y: 0, w: 2000, h: 1000 };
const GAPS = { outer: 0, inner: 0 };   // zones are about geometry, so keep the gaps out of it

function checkTree(root, label) {
    for (const n of preOrder(root)) {
        for (const c of n.children) assert.strictEqual(c.parent, n, `${label}: bad parent link`);
        if (isGroup(n.data)) {
            assert.strictEqual(n.children.length, dataLen(n.data),
                `${label}: ${n.children.length} children, ${dataLen(n.data)} sizes`);
            assert.strictEqual(sum(n.data.sizes), n.data.sizes.reduce((a, b) => a + b, 0));
        }
    }
}

// A measured row of `n` windows across the full area.
function row(n) {
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    appendChild(root, mk('w0'));
    appendChild(root, mk('w1'));
    for (let i = 2; i < n; i++) {
        addWindow(root.data, i);
        appendChild(root, mk('w' + i));
    }
    measure(root, AREA, GAPS);
    return root;
}

// ---------- the descent ----------

{
    const root = row(2);
    const mid0 = root.children[0].data.geo;
    const p = { x: mid0.x + mid0.w / 2, y: mid0.y + mid0.h / 2 };
    assert.strictEqual(nodeUnder(root, p), root.children[0], 'the pointer lands on the window');
}

// A group holding a drop zone stops the descent: the hover resolves at the group, so the fine
// per-window zones are never consulted while a placeholder is open.
{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    appendChild(root, mk('w0'));
    appendChild(root, node(newPlaceholder('ph', DROP_ZONE, { x: 0, y: 0, w: 100, h: 100 })));
    measure(root, AREA, GAPS);

    const g = root.children[0].data.geo;
    const p = { x: g.x + g.w / 2, y: g.y + g.h / 2 };
    assert.strictEqual(nodeUnder(root, p), root, 'the descent stopped at the group');
}

// ---------- group edge bands ----------

{
    const root = row(2);
    // Just inside the left edge of the root group.
    const z = zoneAt(root, { x: AREA.x + 5, y: AREA.h / 2 }, null);
    assert.strictEqual(z.kind, ZONE_GROUP_EDGE);
    assert.strictEqual(z.dir, LEFT);
    assert.strictEqual(z.node, root);
}

{
    const root = row(2);
    const z = zoneAt(root, { x: AREA.w - 5, y: AREA.h / 2 }, null);
    assert.strictEqual(z.dir, RIGHT, 'the right band is the far side');
}
{
    const root = row(2);
    const z = zoneAt(root, { x: AREA.w / 2, y: 5 }, null);
    assert.strictEqual(z.dir, UP);
}
{
    const root = row(2);
    const z = zoneAt(root, { x: AREA.w / 2, y: AREA.h - 5 }, null);
    assert.strictEqual(z.dir, DOWN);
}

// 32 to enter, 80 to leave. A point at x = 50 is outside the band when nothing is committed, but
// inside it once the left edge is the committed zone.
{
    const root = row(2);
    const p = { x: 50, y: AREA.h / 2 };
    assert.ok(50 > EDGE_BAND && 50 < EDGE_BAND_HELD, 'the probe sits between the two widths');

    const cold = zoneAt(root, p, null);
    assert.notStrictEqual(cold.kind, ZONE_GROUP_EDGE, 'not an edge when nothing is held');

    const held = { kind: ZONE_GROUP_EDGE, node: root, dir: LEFT };
    const warm = zoneAt(root, p, held);
    assert.strictEqual(warm.kind, ZONE_GROUP_EDGE, 'the committed edge reaches further out');
    assert.strictEqual(warm.dir, LEFT);
}

// Holding one edge does not widen a different one.
{
    const root = row(2);
    const held = { kind: ZONE_GROUP_EDGE, node: root, dir: RIGHT };
    const z = zoneAt(root, { x: 50, y: AREA.h / 2 }, held);
    assert.notStrictEqual(z.kind, ZONE_GROUP_EDGE, 'the left edge is still only 32 wide');
}

// The bands are carved in order, so the top-left corner belongs to the left band, not the top.
{
    const root = row(2);
    const z = zoneAt(root, { x: 5, y: 5 }, null);
    assert.strictEqual(z.dir, LEFT, 'the corner goes to whichever band was carved first');
}

// ---------- group interior ----------

// Inside the group but not over any child — the gap between two children — is the interior.
// With a real inner gap there is a strip there to aim at.
{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    appendChild(root, mk('w0'));
    appendChild(root, mk('w1'));
    addWindow(root.data, 2);
    appendChild(root, mk('w2'));
    measure(root, AREA, { outer: 0, inner: 24 });

    const a = root.children[0].data.geo;
    const b = root.children[1].data.geo;
    const seamX = (a.x + a.w + b.x) / 2;
    assert.ok(seamX > a.x + a.w && seamX < b.x, 'the probe is in the gap, over neither window');

    const z = zoneAt(root, { x: seamX, y: AREA.h / 2 }, null);
    assert.strictEqual(z.kind, ZONE_GROUP_INTERIOR, 'the gap between children is the interior');
    assert.strictEqual(z.node, root);
    assert.strictEqual(z.idx, 0, 'the seam after child 0');

    const c = root.children[2].data.geo;
    const seam2 = (b.x + b.w + c.x) / 2;
    const z2 = zoneAt(root, { x: seam2, y: AREA.h / 2 }, null);
    assert.strictEqual(z2.idx, 1, 'the next seam is after child 1');
}

// A group holding a drop zone stops the walk and is reported through its first real window,
// rather than resolving a zone against the placeholder.
{
    const g2 = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    const x0 = appendChild(g2, mk('x0'));
    appendChild(g2, mk('x1'));
    addWindow(g2.data, 2);
    appendChild(g2, node(newPlaceholder('ph', DROP_ZONE, { x: 0, y: 0, w: 100, h: 100 })));
    measure(g2, AREA, GAPS);

    const z = zoneAt(g2, { x: AREA.w / 2, y: AREA.h / 2 }, null);
    assert.ok(z.kind === ZONE_WINDOW_SPLIT || z.kind === ZONE_WINDOW_STACK,
        'a group holding a drop zone reports through a real window');
    assert.strictEqual(z.node, x0, 'and that window is its first mapped child');
}

// ---------- the per-window zones ----------

{
    const root = row(2);
    const w = root.children[0];
    const g = w.data.geo;

    // Dead centre: the middle third in both axes.
    const z = zoneAt(root, { x: g.x + g.w / 2, y: g.y + g.h / 2 }, null);
    assert.strictEqual(z.kind, ZONE_WINDOW_STACK, 'the middle third stacks');
    assert.strictEqual(z.node, w);
}

{
    const root = row(2);
    const w = root.children[0];
    const g = w.data.geo;

    // Hard left of the window, vertically centred: nearest edge is the left one.
    let z = zoneAt(root, { x: g.x + g.w * 0.05, y: g.y + g.h / 2 }, null);
    assert.strictEqual(z.kind, ZONE_WINDOW_SPLIT);
    assert.strictEqual(z.dir, LEFT);

    z = zoneAt(root, { x: g.x + g.w * 0.95, y: g.y + g.h / 2 }, null);
    assert.strictEqual(z.dir, RIGHT);

    z = zoneAt(root, { x: g.x + g.w / 2, y: g.y + g.h * 0.05 }, null);
    assert.strictEqual(z.dir, UP);

    z = zoneAt(root, { x: g.x + g.w / 2, y: g.y + g.h * 0.95 }, null);
    assert.strictEqual(z.dir, DOWN);
}

// The side is the nearest edge as a fraction, not in pixels. In a window twice as wide as it is
// tall, a point 10% in from the left and 20% down is nearer the left edge *proportionally*, even
// though in pixels the top edge is closer.
{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 2000, h: 1000 }));
    const w = appendChild(root, mk('only'));
    appendChild(root, mk('other'));
    root.data.sizes = [1600, 400];
    measure(root, { x: 0, y: 0, w: 2000, h: 1000 }, GAPS);

    const g = w.data.geo;
    // 10% in from the left of a 1600-wide window is 160px. 120px down a 1000-tall one is only
    // 12% — nearer in pixels, further as a fraction. The two criteria disagree here, which is
    // the whole point of the probe.
    const dx = g.w * 0.10;
    const dy = 120;
    assert.ok(dy < dx, 'in pixels the top edge really is nearer');
    assert.ok(dy / g.h > dx / g.w, 'but as a fraction the left edge is');

    const z = zoneAt(root, { x: g.x + dx, y: g.y + dy }, null);
    assert.strictEqual(z.dir, LEFT, 'and the fraction is what decides');
}

// ---------- the dwell ----------

assert.strictEqual(dwellElapsed(null, 0, MOUSE_ANIMATION_DELAY), false, 'exactly at the delay is not past it');
assert.strictEqual(dwellElapsed(null, 0, MOUSE_ANIMATION_DELAY + 1), true);
assert.strictEqual(
    dwellElapsed({ kind: ZONE_INITIAL_PLACEHOLDER }, 0, MOUSE_ANIMATION_DELAY + 1), false,
    'leaving your own placeholder is slower than any other move');
assert.strictEqual(
    dwellElapsed({ kind: ZONE_INITIAL_PLACEHOLDER }, 0, INITIAL_MOUSE_ANIMATION_DELAY + 1), true);
assert.ok(INITIAL_MOUSE_ANIMATION_DELAY > MOUSE_ANIMATION_DELAY);

// ---------- dropping on a group edge ----------

{
    const root = row(2);
    const r = dropWindow(root, mk('new'), { kind: ZONE_GROUP_EDGE, node: root, dir: LEFT }, AREA);
    assert.strictEqual(r.root, root, 'the orientation matched, so the group widened in place');
    assert.deepStrictEqual(refs(root), ['new', 'w0', 'w1'], 'the left edge puts it first');
    assert.strictEqual(dataLen(root.data), 3);
    assert.strictEqual(sum(root.data.sizes), AREA.w);
    checkTree(r.root, 'drop group edge left');
}

{
    const root = row(2);
    dropWindow(root, mk('new'), { kind: ZONE_GROUP_EDGE, node: root, dir: RIGHT }, AREA);
    assert.deepStrictEqual(refs(root), ['w0', 'w1', 'new'], 'the right edge puts it last');
}

// An edge that runs across the group wraps it instead of widening it.
{
    const root = row(2);
    const r = dropWindow(root, mk('new'), { kind: ZONE_GROUP_EDGE, node: root, dir: UP }, AREA);
    assert.notStrictEqual(r.root, root, 'the root was wrapped');
    assert.strictEqual(r.root.data.orientation, HORIZONTAL);
    assert.deepStrictEqual(refs(r.root), ['new', '<group>'], 'the top edge puts it above');
    assert.strictEqual(dataLen(root.data), 2, "the wrapped group's own vector is untouched");
    checkTree(r.root, 'drop group edge up');
}

// ---------- dropping in a group interior ----------

{
    const root = row(3);
    const r = dropWindow(root, mk('new'), { kind: ZONE_GROUP_INTERIOR, node: root, idx: 0 }, AREA);
    assert.strictEqual(r.root, root);
    assert.deepStrictEqual(refs(root), ['w0', 'new', 'w1', 'w2'],
        'interior index 0 means after the first child');
    assert.strictEqual(dataLen(root.data), 4);
    assert.strictEqual(sum(root.data.sizes), AREA.w, 'the row still fills the group exactly');
    checkTree(r.root, 'drop interior 0');
}

{
    const root = row(3);
    dropWindow(root, mk('new'), { kind: ZONE_GROUP_INTERIOR, node: root, idx: 1 }, AREA);
    assert.deepStrictEqual(refs(root), ['w0', 'w1', 'new', 'w2']);
}

// The index is clamped, because the layout may have changed while the pointer dwelled.
{
    const root = row(2);
    const r = dropWindow(root, mk('new'), { kind: ZONE_GROUP_INTERIOR, node: root, idx: 99 }, AREA);
    assert.deepStrictEqual(refs(root), ['w0', 'w1', 'new'], 'a stale index lands at the end');
    assert.strictEqual(dataLen(root.data), 3);
    checkTree(r.root, 'drop interior clamped');
}

// ---------- dropping on a window ----------

{
    const root = row(2);
    const w1 = root.children[1];
    const r = dropWindow(root, mk('new'), { kind: ZONE_WINDOW_SPLIT, node: w1, dir: RIGHT }, AREA);
    assert.strictEqual(r.root, root);
    const g = root.children[1];
    assert.ok(isGroup(g.data), 'the window was replaced in place by a group');
    assert.strictEqual(g.data.orientation, VERTICAL);
    assert.deepStrictEqual(refs(g), ['w1', 'new'], 'a right split puts the newcomer second');
    checkTree(r.root, 'drop window split right');
}

{
    const root = row(2);
    const w1 = root.children[1];
    dropWindow(root, mk('new'), { kind: ZONE_WINDOW_SPLIT, node: w1, dir: LEFT }, AREA);
    assert.deepStrictEqual(refs(root.children[1]), ['new', 'w1'], 'a left split puts it first');
}

{
    const root = row(2);
    const w1 = root.children[1];
    const r = dropWindow(root, mk('new'), { kind: ZONE_WINDOW_SPLIT, node: w1, dir: DOWN }, AREA);
    assert.strictEqual(root.children[1].data.orientation, HORIZONTAL, 'up/down splits horizontally');
    checkTree(r.root, 'drop window split down');
}

// Splitting the root window promotes the new group to root.
{
    const only = mk('only');
    const r = dropWindow(only, mk('new'), { kind: ZONE_WINDOW_SPLIT, node: only, dir: RIGHT }, AREA);
    assert.notStrictEqual(r.root, only, 'the root moved');
    assert.deepStrictEqual(refs(r.root), ['only', 'new']);
}

// ---------- dropping back on your own placeholder ----------

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    appendChild(root, mk('w0'));
    const ph = appendChild(root, node(newPlaceholder('ph', GRABBED_WINDOW, { x: 0, y: 0, w: 1, h: 1 })));
    measure(root, AREA, GAPS);
    const was = { ...ph.data.geo };

    const r = dropWindow(root, mk('back'), { kind: ZONE_INITIAL_PLACEHOLDER, node: ph }, AREA);
    assert.strictEqual(r.root, root, 'nothing was restructured');
    assert.ok(isMapped(ph.data), 'the placeholder became the window');
    assert.strictEqual(ph.data.ref, 'back');
    assert.deepStrictEqual(ph.data.geo, was, 'and kept the rectangle it was holding');
    assert.strictEqual(dataLen(root.data), 2, 'the group is unchanged');
    checkTree(r.root, 'drop on own placeholder');
}

// ---------- an unknown zone maps normally rather than losing the window ----------

{
    const root = row(2);
    const r = dropWindow(root, mk('new'), null, { w: AREA.w, h: AREA.h });
    const windows = preOrder(r.root).filter((n) => isMapped(n.data)).map((n) => n.data.ref);
    assert.ok(windows.includes('new'), 'the window is still in the tree');
    assert.strictEqual(windows.length, 3);
    checkTree(r.root, 'drop with no zone');
}

// A stack drop turns the target into a stack and merges into it. The tree keeps its shape: a
// stack is a kind of leaf, so no node is added. sim24 covers the stack model itself.
{
    const root = row(2);
    const w0 = root.children[0];
    const r = dropWindow(root, mk('new'), { kind: ZONE_WINDOW_STACK, node: w0, geo: w0.data.geo }, AREA);

    assert.strictEqual(r.root, root, 'nothing was restructured');
    assert.strictEqual(root.children.length, 2, 'and no node was added');
    assert.strictEqual(r.target, w0, 'the drop reports the stack it joined');
    assert.deepStrictEqual(w0.data.windows, ['w0', 'new'], 'both windows are in the leaf');
    assert.ok(w0.data.stacked);
    checkTree(r.root, 'drop onto a stack');
}

// ---------- zonesEqual ----------

{
    const a = { kind: ZONE_GROUP_EDGE, node: 'n', dir: LEFT };
    assert.ok(zonesEqual(a, { kind: ZONE_GROUP_EDGE, node: 'n', dir: LEFT }));
    assert.ok(!zonesEqual(a, { kind: ZONE_GROUP_EDGE, node: 'n', dir: RIGHT }));
    assert.ok(!zonesEqual(a, { kind: ZONE_GROUP_INTERIOR, node: 'n', idx: 0 }));
    assert.ok(!zonesEqual(a, null));
    assert.ok(zonesEqual(null, null));
}

console.log('ALL OK');
