// Mirrors cosmic-comp possible_resizes :2443, resize_request :2477 and resize :2514.
import assert from 'node:assert';
import path from 'node:path';

const tiler = process.argv[2];
const core = await import(path.join(path.dirname(tiler), 'core.mjs'));
const {
    HORIZONTAL, VERTICAL,
    EDGE_TOP, EDGE_BOTTOM, EDGE_LEFT, EDGE_RIGHT,
    INWARDS, OUTWARDS, MIN_PANE, MIN_PAIR,
    newGroup, newMapped, addWindow,
    node, appendChild, measure,
    resize, resizeRequest, possibleResizes,
} = core;

const sum = (a) => a.reduce((x, y) => x + y, 0);
const mk = (ref) => node(newMapped(ref, { x: 0, y: 0, w: 0, h: 0 }));

function row(n, width) {
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: width, h: 1000 }));
    appendChild(root, mk('w0'));
    appendChild(root, mk('w1'));
    for (let i = 2; i < n; i++) {
        addWindow(root.data, i);
        appendChild(root, mk('w' + i));
    }
    return root;
}

{
    const root = row(3, 3000);
    const [a, b, c] = root.children;
    assert.strictEqual(possibleResizes(a) & EDGE_LEFT, 0, 'the first child has nothing to its left');
    assert.ok(possibleResizes(a) & EDGE_RIGHT, 'but it can push right');
    assert.ok(possibleResizes(b) & EDGE_LEFT, 'the middle child can go both ways');
    assert.ok(possibleResizes(b) & EDGE_RIGHT);
    assert.strictEqual(possibleResizes(c) & EDGE_RIGHT, 0, 'the last child has nothing to its right');
    assert.strictEqual(possibleResizes(a) & (EDGE_TOP | EDGE_BOTTOM), 0,
        'a vertical group offers no vertical edges');
}

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 2000, h: 1000 }));
    const left = appendChild(root, node(newGroup(HORIZONTAL, { x: 0, y: 0, w: 1000, h: 1000 })));
    appendChild(root, mk('right'));
    const top = appendChild(left, mk('top'));
    appendChild(left, mk('bottom'));

    const e = possibleResizes(top);
    assert.ok(e & EDGE_BOTTOM, 'it has a sibling below inside its own group');
    assert.ok(e & EDGE_RIGHT, 'and the outer group gives it a right edge too');
    assert.strictEqual(e & EDGE_TOP, 0);
    assert.strictEqual(e & EDGE_LEFT, 0);
}

{
    const root = row(3, 3000);
    const [, b] = root.children;
    const left = resizeRequest(b, EDGE_LEFT);
    assert.strictEqual(left.group, root);
    assert.strictEqual(left.idx, 0, 'the left edge of child 1 is the seam after size 0');
    const right = resizeRequest(b, EDGE_RIGHT);
    assert.strictEqual(right.idx, 1, 'the right edge of child 1 is the seam after size 1');
    assert.strictEqual(resizeRequest(root.children[0], EDGE_LEFT), null,
        'the outermost edge belongs to no seam');
}

{
    const root = row(3, 3000);
    const before = root.data.sizes.slice();
    const total = sum(before);

    const r = resize(root, root.children[1], INWARDS, EDGE_LEFT, 100);
    assert.ok(r.handled && r.changed);
    const after = root.data.sizes;
    assert.strictEqual(sum(after), total, 'the group total is conserved');
    assert.strictEqual(after[1], before[1] - 100, 'Inwards shrinks the focused node');
    assert.strictEqual(after[0], before[0] + 100, 'and its left neighbour takes the difference');
    assert.strictEqual(after[2], before[2], 'nothing else moves');
}

{
    const root = row(3, 3000);
    const before = root.data.sizes.slice();
    resize(root, root.children[1], OUTWARDS, EDGE_LEFT, 100);
    const after = root.data.sizes;
    assert.strictEqual(after[1], before[1] + 100, 'Outwards grows the focused node');
    assert.strictEqual(after[0], before[0] - 100);
    assert.strictEqual(sum(after), sum(before));
}

{
    const root = row(3, 3000);
    const before = root.data.sizes.slice();
    resize(root, root.children[1], INWARDS, EDGE_RIGHT, 100);
    const after = root.data.sizes;
    assert.strictEqual(after[1], before[1] - 100);
    assert.strictEqual(after[2], before[2] + 100, 'the right neighbour grew');
    assert.strictEqual(after[0], before[0], 'the left one did not');
}

{
    const root = row(2, 1000);
    root.data.sizes = [500, 500];
    const r = resize(root, root.children[0], INWARDS, EDGE_RIGHT, 1000);
    assert.ok(r.changed);
    assert.strictEqual(root.data.sizes[0], MIN_PANE[VERTICAL], 'clamped at the pane minimum');
    assert.strictEqual(root.data.sizes[1], 1000 - MIN_PANE[VERTICAL],
        'the neighbour got exactly what was freed, not the amount asked for');
    assert.strictEqual(sum(root.data.sizes), 1000);
}

{
    const root = row(2, 600);
    root.data.sizes = [300, 300];
    assert.ok(sum(root.data.sizes) < MIN_PAIR[VERTICAL]);
    const before = root.data.sizes.slice();
    const r = resize(root, root.children[0], INWARDS, EDGE_RIGHT, 50);
    assert.strictEqual(r.handled, true, 'the gesture was understood');
    assert.strictEqual(r.changed, false, 'but nothing moved');
    assert.deepStrictEqual(root.data.sizes, before);
}

{
    const root = row(2, 1000);
    root.data.sizes = [MIN_PANE[VERTICAL], 1000 - MIN_PANE[VERTICAL]];
    const r = resize(root, root.children[0], INWARDS, EDGE_RIGHT, 100);
    assert.strictEqual(r.changed, false, 'nothing left to give');
}

// Regression: clampSizes can leave a pane under MIN_PANE ([380, 356] seen live), and
// max(old - amount, MIN_PANE) then moved the pair the wrong way before going dead.
{
    const root = row(2, 1000);
    root.data.sizes = [356, 644];
    assert.ok(root.data.sizes[0] < MIN_PANE[VERTICAL], 'the pane starts under the minimum');
    assert.ok(sum(root.data.sizes) >= MIN_PAIR[VERTICAL], 'and the pair guard does not cover it');
    const r = resize(root, root.children[0], INWARDS, EDGE_RIGHT, 12);
    assert.strictEqual(r.changed, false, 'nothing moved');
    assert.deepStrictEqual(root.data.sizes, [356, 644], 'and nothing moved the wrong way either');
}

{
    const root = node(newGroup(HORIZONTAL, { x: 0, y: 0, w: 1000, h: 1000 }));
    appendChild(root, mk('top'));
    appendChild(root, mk('bottom'));
    root.data.sizes = [500, 500];
    resize(root, root.children[0], INWARDS, EDGE_BOTTOM, 1000);
    assert.strictEqual(root.data.sizes[0], MIN_PANE[HORIZONTAL],
        'a horizontal group clamps at 240, not 360');
    assert.notStrictEqual(MIN_PANE[HORIZONTAL], MIN_PANE[VERTICAL]);
    assert.notStrictEqual(MIN_PAIR[HORIZONTAL], MIN_PAIR[VERTICAL]);
}

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 2000, h: 1000 }));
    const left = appendChild(root, node(newGroup(HORIZONTAL, { x: 0, y: 0, w: 1000, h: 1000 })));
    appendChild(root, mk('right'));
    const top = appendChild(left, mk('top'));
    appendChild(left, mk('bottom'));
    root.data.sizes = [1000, 1000];
    left.data.sizes = [500, 500];

    const r = resize(root, top, INWARDS, EDGE_RIGHT, 100);
    assert.ok(r.changed);
    assert.deepStrictEqual(left.data.sizes, [500, 500], 'the inner group was left alone');
    assert.deepStrictEqual(root.data.sizes, [900, 1100], 'the outer group took the resize');
}

{
    const root = row(2, 2000);
    const r = resize(root, root.children[0], INWARDS, EDGE_LEFT, 100);
    assert.strictEqual(r.changed, false, 'nothing to the left of the first child');
    assert.deepStrictEqual(root.data.sizes, [1000, 1000]);
}

{
    const root = row(2, 1000);
    root.data.sizes = [500, 500];
    resize(root, root.children[0], OUTWARDS, EDGE_RIGHT, 100);
    assert.deepStrictEqual(root.data.sizes, [600, 400]);

    const { configures } = measure(root, { x: 0, y: 0, w: 1000, h: 800 }, { outer: 8, inner: 8 });
    const by = Object.fromEntries(configures.map((c) => [c.node.data.ref, c.geo]));
    assert.ok(by.w0.w > by.w1.w, 'the grown pane is the wider one on screen');
    // measure rescales into the work area, so the ratio is what survives, not the raw number.
    const ratio = by.w0.w / (by.w0.w + by.w1.w);
    assert.ok(ratio > 0.55 && ratio < 0.65, `expected roughly 60/40, got ${ratio.toFixed(3)}`);
}

console.log('ALL OK');
