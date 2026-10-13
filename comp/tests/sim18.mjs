// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// The pure core: cosmic-comp's `impl Data` arithmetic and the measure that turns a size vector
// into rectangles. Every expected number here was computed by hand from the Rust, not by running
// the JavaScript and recording what it said.
//
// The assertions below are written against the Rust rather than against the implementation, which
// is where their value is: a plausible-but-wrong translation passes a test written from the code
// it is testing.
//
// What a plausible-but-wrong translation gets wrong, and what each section pins down:
//   - add_window: the new child takes the leftover, not `equal_sizing`
//   - remove_window: `remaining` is summed after the removal; overflow lands on the last element
//   - Orientation names the dividing line, so Horizontal splits *height*
//   - the gap model is half-between-neighbours, which must total exactly one `inner`
//   - flattening lifts the only child into the group's own index, not onto the end
import assert from 'node:assert';
import path from 'node:path';

const tiler = process.argv[2];
const core = await import(path.join(path.dirname(tiler), 'core.mjs'));
const {
    idiv, roundI32, HORIZONTAL, VERTICAL,
    newGroup, newMapped, addWindow, removeWindow, updateGeometry, dataLen,
    node, appendChild, measure, preOrder, isMapped,
} = core;

const sum = (a) => a.reduce((x, y) => x + y, 0);

// ---------- Rust casts ----------

assert.strictEqual(idiv(1000, 3), 333, 'i32 division truncates');
assert.strictEqual(idiv(-7, 2), -3, 'i32 division truncates toward zero, not down');

// f64::round breaks ties away from zero; Math.round breaks them toward +Infinity.
assert.strictEqual(roundI32(0.5), 1);
assert.strictEqual(roundI32(-0.5), -1, 'ties away from zero, where Math.round gives -0');
assert.strictEqual(roundI32(-1.5), -2);
// `as i32` turns NaN into 0, which remove_window depends on when the remainder is zero.
assert.strictEqual(roundI32(NaN), 0, 'NaN casts to 0, not NaN');
assert.strictEqual(roundI32(0 / 0), 0);

// ---------- add_window ----------

const g = newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 800 });
assert.deepStrictEqual(g.sizes, [500, 500], 'new_group splits the width in two');

addWindow(g, 1);
// last = 1000; equal = 1000/3 = 333; remainder = 1000 - 333 = 667
// each survivor: round(500/1000 * 667) = round(333.5) = 334
// used = 668, so the newcomer gets 1000 - 668 = 332 and is inserted at index 1.
assert.deepStrictEqual(g.sizes, [334, 332, 334],
    'the new child takes the leftover (332), not equal_sizing (333)');
assert.strictEqual(sum(g.sizes), 1000, 'the vector still sums to the group length');

// ---------- remove_window ----------

removeWindow(g, 1);
// old = 332; survivors [334, 334]; remaining = 668
// each: 334 + round(334/668 * 332) = 334 + 166 = 500
assert.deepStrictEqual(g.sizes, [500, 500], 'removing the newcomer restores the split exactly');
assert.strictEqual(sum(g.sizes), 1000);

// Removing from an uneven vector: the rounding error goes onto the last element only.
const u = newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 800 });
u.sizes = [333, 333, 334];
removeWindow(u, 0);
// old = 333; survivors [333, 334]; remaining = 667
// 333 + round(333/667 * 333) = 333 + round(166.2503) = 333 + 166 = 499
// 334 + round(334/667 * 333) = 334 + round(166.7496) = 334 + 167 = 501
assert.deepStrictEqual(u.sizes, [499, 501]);
assert.strictEqual(sum(u.sizes), 1000, 'still exact after an uneven removal');

// ---------- update_geometry ----------

const r = newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 800 });
updateGeometry(r, { x: 0, y: 0, w: 984, h: 784 });
assert.deepStrictEqual(r.sizes, [492, 492], 'sizes rescale into the new length');
assert.strictEqual(sum(r.sizes), 984, 'and sum to it exactly');

// A length that does not divide evenly still sums, because the error is pushed onto the last.
const odd = newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 800 });
updateGeometry(odd, { x: 0, y: 0, w: 999, h: 800 });
assert.strictEqual(sum(odd.sizes), 999, 'rounding error absorbed by the last element');

// ---------- measure: one window ----------

const area = { x: 0, y: 0, w: 1000, h: 800 };
const gaps = { outer: 8, inner: 8 };

{
    const root = node(newMapped('w1', { x: 0, y: 0, w: 0, h: 0 }));
    const { configures } = measure(root, area, gaps);
    assert.strictEqual(configures.length, 1);
    // outer 8 from the work area, then a full inner 8 on every side: no neighbours anywhere.
    assert.deepStrictEqual(configures[0].geo, { x: 16, y: 16, w: 968, h: 768 });
}

// ---------- measure: two side by side, and the gap between them ----------

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 800 }));
    const a = appendChild(root, node(newMapped('a', { x: 0, y: 0, w: 0, h: 0 })));
    const b = appendChild(root, node(newMapped('b', { x: 0, y: 0, w: 0, h: 0 })));
    const { configures } = measure(root, area, gaps);

    const byRef = Object.fromEntries(configures.map((c) => [c.node.data.ref, c.geo]));
    assert.deepStrictEqual(byRef.a, { x: 16, y: 16, w: 480, h: 768 });
    assert.deepStrictEqual(byRef.b, { x: 504, y: 16, w: 480, h: 768 });

    // The seam is exactly one inner gap: half from each side, not one each.
    const seam = byRef.b.x - (byRef.a.x + byRef.a.w);
    assert.strictEqual(seam, gaps.inner, 'half a gap from each neighbour makes one whole gap');

    // The outside is outer + inner, and the two margins match.
    assert.strictEqual(byRef.a.x, gaps.outer + gaps.inner);
    assert.strictEqual(area.w - (byRef.b.x + byRef.b.w), gaps.outer + gaps.inner);
    assert.strictEqual(byRef.a.w, byRef.b.w, 'an even split stays even through the gap maths');
    void a; void b;
}

// ---------- measure: Horizontal splits the height ----------

{
    const root = node(newGroup(HORIZONTAL, { x: 0, y: 0, w: 1000, h: 800 }));
    appendChild(root, node(newMapped('top', { x: 0, y: 0, w: 0, h: 0 })));
    appendChild(root, node(newMapped('bot', { x: 0, y: 0, w: 0, h: 0 })));
    const { configures } = measure(root, area, gaps);
    const byRef = Object.fromEntries(configures.map((c) => [c.node.data.ref, c.geo]));

    // Children run top to bottom and share the full width — this is the assertion that catches
    // the orientation convention being read the other way round.
    assert.strictEqual(byRef.top.y, 16);
    assert.ok(byRef.bot.y > byRef.top.y, 'Horizontal stacks its children vertically');
    assert.strictEqual(byRef.top.x, byRef.bot.x, 'and they share a column');
    assert.strictEqual(byRef.top.w, byRef.bot.w);
    const seam = byRef.bot.y - (byRef.top.y + byRef.top.h);
    assert.strictEqual(seam, gaps.inner, 'the horizontal seam is one inner gap too');
}

// ---------- measure: a one-child group is flattened into its own index ----------

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 800 }));
    const inner = appendChild(root, node(newGroup(VERTICAL, { x: 0, y: 0, w: 500, h: 800 })));
    const last = appendChild(root, node(newMapped('last', { x: 0, y: 0, w: 0, h: 0 })));
    // Drive the inner group down to a single child through the real operation.
    removeWindow(inner.data, 1);
    appendChild(inner, node(newMapped('only', { x: 0, y: 0, w: 0, h: 0 })));
    assert.strictEqual(dataLen(inner.data), 1);

    const { root: after } = measure(root, area, gaps);
    assert.strictEqual(after, root, 'flattening below the root does not move the root');

    const kinds = root.children.map((c) => c.data.ref);
    assert.deepStrictEqual(kinds, ['only', 'last'],
        'the only child is lifted into the group index, not appended after it');
    void last;
}

// ---------- measure: children tile their group with no overlap ----------

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 800 }));
    for (let i = 0; i < 2; i++) appendChild(root, node(newMapped('w' + i, { x: 0, y: 0, w: 0, h: 0 })));
    addWindow(root.data, 2);
    appendChild(root, node(newMapped('w2', { x: 0, y: 0, w: 0, h: 0 })));

    const { configures } = measure(root, area, gaps);
    assert.strictEqual(configures.length, 3);
    const xs = configures.map((c) => c.geo).sort((p, q) => p.x - q.x);
    for (let i = 1; i < xs.length; i++) {
        const seam = xs[i].x - (xs[i - 1].x + xs[i - 1].w);
        assert.strictEqual(seam, gaps.inner, `seam ${i} is one inner gap, got ${seam}`);
    }
    assert.strictEqual(sum(root.data.sizes), 984, 'three sizes still sum to the group width');
    // Every rect is inside the work area.
    for (const c of configures) {
        assert.ok(c.geo.x >= area.x && c.geo.y >= area.y);
        assert.ok(c.geo.x + c.geo.w <= area.x + area.w);
        assert.ok(c.geo.y + c.geo.h <= area.y + area.h);
    }
}

// ---------- preOrder visits parents before children ----------

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 100, h: 100 }));
    const a = appendChild(root, node(newMapped('a', { x: 0, y: 0, w: 0, h: 0 })));
    const order = preOrder(root);
    assert.strictEqual(order[0], root);
    assert.strictEqual(order[1], a);
    assert.ok(isMapped(a.data));
}

console.log('ALL OK');
