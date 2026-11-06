// Mirrors cosmic-comp update_pointer_position :3386 and drop_window :2666.
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

{
    const root = row(2);
    const mid0 = root.children[0].data.geo;
    const p = { x: mid0.x + mid0.w / 2, y: mid0.y + mid0.h / 2 };
    assert.strictEqual(nodeUnder(root, p), root.children[0], 'the pointer lands on the window');
}

// A group holding a drop zone stops the descent, so a live layout does not chase the pointer.
{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    appendChild(root, mk('w0'));
    appendChild(root, node(newPlaceholder('ph', DROP_ZONE, { x: 0, y: 0, w: 100, h: 100 })));
    measure(root, AREA, GAPS);

    const g = root.children[0].data.geo;
    const p = { x: g.x + g.w / 2, y: g.y + g.h / 2 };
    assert.strictEqual(nodeUnder(root, p), root, 'the descent stopped at the group');
}

{
    const root = row(2);
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

// Hysteresis: the committed edge band is wider, so x = 50 is an edge only while it is held.
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

{
    const root = row(2);
    const w = root.children[0];
    const g = w.data.geo;

    const z = zoneAt(root, { x: g.x + g.w / 2, y: g.y + g.h / 2 }, null);
    assert.strictEqual(z.kind, ZONE_WINDOW_STACK, 'the middle third stacks');
    assert.strictEqual(z.node, w);
}

{
    const root = row(2);
    const w = root.children[0];
    const g = w.data.geo;

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

// The split side is the nearest edge as a fraction of the window, not in pixels.
{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 2000, h: 1000 }));
    const w = appendChild(root, mk('only'));
    appendChild(root, mk('other'));
    root.data.sizes = [1600, 400];
    measure(root, { x: 0, y: 0, w: 2000, h: 1000 }, GAPS);

    const g = w.data.geo;
    const dx = g.w * 0.10;
    const dy = 120;
    assert.ok(dy < dx, 'in pixels the top edge really is nearer');
    assert.ok(dy / g.h > dx / g.w, 'but as a fraction the left edge is');

    const z = zoneAt(root, { x: g.x + dx, y: g.y + dy }, null);
    assert.strictEqual(z.dir, LEFT, 'and the fraction is what decides');
}

assert.strictEqual(dwellElapsed(null, 0, MOUSE_ANIMATION_DELAY), false, 'exactly at the delay is not past it');
assert.strictEqual(dwellElapsed(null, 0, MOUSE_ANIMATION_DELAY + 1), true);
assert.strictEqual(
    dwellElapsed({ kind: ZONE_INITIAL_PLACEHOLDER }, 0, MOUSE_ANIMATION_DELAY + 1), false,
    'leaving your own placeholder is slower than any other move');
assert.strictEqual(
    dwellElapsed({ kind: ZONE_INITIAL_PLACEHOLDER }, 0, INITIAL_MOUSE_ANIMATION_DELAY + 1), true);
assert.ok(INITIAL_MOUSE_ANIMATION_DELAY > MOUSE_ANIMATION_DELAY);

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

{
    const root = row(2);
    const r = dropWindow(root, mk('new'), { kind: ZONE_GROUP_EDGE, node: root, dir: UP }, AREA);
    assert.notStrictEqual(r.root, root, 'the root was wrapped');
    assert.strictEqual(r.root.data.orientation, HORIZONTAL);
    assert.deepStrictEqual(refs(r.root), ['new', '<group>'], 'the top edge puts it above');
    assert.strictEqual(dataLen(root.data), 2, "the wrapped group's own vector is untouched");
    checkTree(r.root, 'drop group edge up');
}

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

{
    const only = mk('only');
    const r = dropWindow(only, mk('new'), { kind: ZONE_WINDOW_SPLIT, node: only, dir: RIGHT }, AREA);
    assert.notStrictEqual(r.root, only, 'the root moved');
    assert.deepStrictEqual(refs(r.root), ['only', 'new']);
}

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

{
    const root = row(2);
    const r = dropWindow(root, mk('new'), null, { w: AREA.w, h: AREA.h });
    const windows = preOrder(r.root).filter((n) => isMapped(n.data)).map((n) => n.data.ref);
    assert.ok(windows.includes('new'), 'the window is still in the tree');
    assert.strictEqual(windows.length, 3);
    checkTree(r.root, 'drop with no zone');
}

// A stack is a kind of leaf, so a stack drop adds no node; sim24 covers the stack model.
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

{
    const a = { kind: ZONE_GROUP_EDGE, node: 'n', dir: LEFT };
    assert.ok(zonesEqual(a, { kind: ZONE_GROUP_EDGE, node: 'n', dir: LEFT }));
    assert.ok(!zonesEqual(a, { kind: ZONE_GROUP_EDGE, node: 'n', dir: RIGHT }));
    assert.ok(!zonesEqual(a, { kind: ZONE_GROUP_INTERIOR, node: 'n', idx: 0 }));
    assert.ok(!zonesEqual(a, null));
    assert.ok(zonesEqual(null, null));
}

console.log('ALL OK');
