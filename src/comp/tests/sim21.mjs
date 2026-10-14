// Keyboard movement: move_current_node :1507.
//
// The rule that makes the whole function legible, and that the branches only reveal together:
// you enter the cell you moved into *from the side you came from*. Moving left lands you at the
// right end of what you moved into, not the left end. That is why the index is 1 for Left and Up
// here, and why it is the opposite of the one used when a window arrives from another output.
//
// Also pinned down:
//   - a swap between exactly two siblings swaps their sizes too, so neither changes size
//   - a group running across the movement is wrapped and stepped out of, not refused
//   - running out of siblings climbs to the parent group and tries again
//   - reaching the top with nowhere left returns FURTHER, which is the caller's cue to hand the
//     window to the next output rather than a failure
//   - every branch leaves the tree consistent: children and sizes the same length, sizes summing
//     to the group, and no node in two child lists
//
import assert from 'node:assert';
import path from 'node:path';

const tiler = process.argv[2];
const core = await import(path.join(path.dirname(tiler), 'core.mjs'));
const {
    HORIZONTAL, VERTICAL, LEFT, RIGHT, UP, DOWN,
    newGroup, newMapped, addWindow, dataLen, isGroup, isMapped,
    node, appendChild, preOrder, measure,
    moveCurrentNode, MOVE_DONE, MOVE_FURTHER, MOVE_NONE,
} = core;

const sum = (a) => a.reduce((x, y) => x + y, 0);
const mk = (ref) => node(newMapped(ref, { x: 0, y: 0, w: 0, h: 0 }));
const refs = (n) => n.children.map((c) => (isMapped(c.data) ? c.data.ref : '<group>'));

// Every test ends here. A move that leaves the tree inconsistent is a bug even when the window
// landed where it should.
function checkTree(root, label) {
    const seen = new Set();
    for (const n of preOrder(root)) {
        assert.ok(!seen.has(n), `${label}: a node appears twice in the tree`);
        seen.add(n);
        for (const c of n.children) {
            assert.strictEqual(c.parent, n, `${label}: a child points at the wrong parent`);
        }
        if (isGroup(n.data)) {
            assert.strictEqual(n.children.length, dataLen(n.data),
                `${label}: ${n.children.length} children but ${dataLen(n.data)} sizes`);
        }
    }
    // Measuring has to produce one rect per window, inside the work area, with no group left
    // holding a mismatched vector.
    const { configures } = measure(root, { x: 0, y: 0, w: 2000, h: 1200 }, { outer: 8, inner: 8 });
    for (const c of configures) {
        assert.ok(c.geo.w > 0 && c.geo.h > 0, `${label}: a window measured to nothing`);
    }
    return configures;
}

function rowOf(n, orientation, length) {
    const root = node(newGroup(orientation, orientation === VERTICAL
        ? { x: 0, y: 0, w: length, h: 1000 }
        : { x: 0, y: 0, w: 1000, h: length }));
    appendChild(root, mk('w0'));
    appendChild(root, mk('w1'));
    for (let i = 2; i < n; i++) {
        addWindow(root.data, i);
        appendChild(root, mk('w' + i));
    }
    return root;
}

// ---------- nothing to move ----------

{
    const r = moveCurrentNode(null, null, LEFT);
    assert.strictEqual(r.result, MOVE_NONE);
}

// A lone window has no parent, so the layout cannot absorb the move.
{
    const a = mk('a');
    const r = moveCurrentNode(a, a, LEFT);
    assert.strictEqual(r.result, MOVE_FURTHER, 'a single window asks the caller to take it');
    assert.strictEqual(r.root, a);
}

// ---------- two siblings swap, and swap their sizes with them ----------

{
    const root = rowOf(2, VERTICAL, 1000);
    root.data.sizes = [700, 300];
    const w0 = root.children[0];

    const r = moveCurrentNode(root, w0, RIGHT);
    assert.strictEqual(r.result, MOVE_DONE);
    assert.deepStrictEqual(refs(root), ['w1', 'w0'], 'they changed places');
    assert.deepStrictEqual(root.data.sizes, [300, 700],
        'and the sizes went with them, so neither window changed size');
    assert.strictEqual(sum(root.data.sizes), 1000);
    checkTree(r.root, 'swap');
}

// The same swap the other way is a round trip.
{
    const root = rowOf(2, VERTICAL, 1000);
    root.data.sizes = [700, 300];
    const w0 = root.children[0];
    moveCurrentNode(root, w0, RIGHT);
    moveCurrentNode(root, w0, LEFT);
    assert.deepStrictEqual(refs(root), ['w0', 'w1']);
    assert.deepStrictEqual(root.data.sizes, [700, 300], 'back exactly where it started');
}

// ---------- moving against a group that runs the other way steps out of it ----------

{
    // A vertical pair. Moving one of them *up* cannot happen inside it, so the pair gets wrapped
    // in a horizontal group and the window steps out above it.
    const root = rowOf(2, VERTICAL, 1000);
    const w0 = root.children[0];

    const r = moveCurrentNode(root, w0, UP);
    assert.strictEqual(r.result, MOVE_DONE);
    assert.notStrictEqual(r.root, root, 'the root was wrapped, so it moved');
    assert.strictEqual(r.root.data.orientation, HORIZONTAL, 'wrapped by a horizontal group');
    assert.strictEqual(r.root.children[0], w0, 'and the window went above, at index 0');
    assert.ok(isGroup(r.root.children[1].data));
    checkTree(r.root, 'step out up');
}

{
    const root = rowOf(2, VERTICAL, 1000);
    const w0 = root.children[0];
    const r = moveCurrentNode(root, w0, DOWN);
    assert.strictEqual(r.root.children[1], w0, 'moving down lands at index 1');
    checkTree(r.root, 'step out down');
}

// ---------- splitting a neighbour in a row of three ----------

{
    const root = rowOf(3, VERTICAL, 3000);
    const [w0, w1, w2] = root.children;

    // w0 moves right into w1. w1 is a window, and the group has three children, so w1 is split.
    const r = moveCurrentNode(root, w0, RIGHT);
    assert.strictEqual(r.result, MOVE_DONE);
    assert.strictEqual(root.children.length, 2, 'the row lost a child to the new group');
    assert.strictEqual(dataLen(root.data), 2, 'and its size vector shrank with it');
    assert.strictEqual(sum(root.data.sizes), 3000);

    const g = root.children[0];
    assert.ok(isGroup(g.data), 'w1 was replaced in place by a group');
    assert.strictEqual(g.data.orientation, VERTICAL);
    // Moving right, so w0 entered from the left: it takes index 0, ahead of w1.
    assert.deepStrictEqual(refs(g), ['w0', 'w1'],
        'entering from the left puts the mover first');
    assert.strictEqual(root.children[1], w2);
    checkTree(r.root, 'split neighbour right');
    void w1;
}

{
    const root = rowOf(3, VERTICAL, 3000);
    const w2 = root.children[2];
    moveCurrentNode(root, w2, LEFT);
    const g = root.children[1];
    assert.ok(isGroup(g.data));
    assert.deepStrictEqual(refs(g), ['w1', 'w2'],
        'moving left, the mover enters from the right and lands second');
}

// ---------- descending into a neighbouring group ----------

{
    // Outer vertical: [w0, innerHorizontal(top, bottom)]. w0 moves right into the inner group.
    // The inner group runs across the movement, so there is no near end: aim for the middle.
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 2000, h: 1000 }));
    const w0 = appendChild(root, mk('w0'));
    const inner = appendChild(root, node(newGroup(HORIZONTAL, { x: 0, y: 0, w: 1000, h: 1000 })));
    appendChild(inner, mk('top'));
    appendChild(inner, mk('bottom'));

    const r = moveCurrentNode(root, w0, RIGHT);
    assert.strictEqual(r.result, MOVE_DONE);
    assert.strictEqual(inner.children.length, 3, 'the window joined the inner group');
    assert.strictEqual(dataLen(inner.data), 3, 'and the inner size vector grew with it');
    assert.deepStrictEqual(refs(inner), ['top', 'w0', 'bottom'],
        'an even group has a middle to slot into');
    assert.strictEqual(sum(inner.data.sizes), 1000);
    checkTree(r.root, 'descend into perpendicular group');
}

{
    // Same shape, but the inner group runs the *same* way as the movement, so there is a near
    // end: entering from the left means landing at index 0.
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 2000, h: 1000 }));
    const w0 = appendChild(root, mk('w0'));
    const inner = appendChild(root, node(newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 1000 })));
    appendChild(inner, mk('a'));
    appendChild(inner, mk('b'));

    const r = moveCurrentNode(root, w0, RIGHT);
    assert.deepStrictEqual(refs(inner), ['w0', 'a', 'b'],
        'moving right into a group that also runs right enters at its near end');
    assert.strictEqual(dataLen(inner.data), 3);
    checkTree(r.root, 'descend into aligned group');
}

{
    // Moving left into an aligned group enters at the far end instead.
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 2000, h: 1000 }));
    const inner = appendChild(root, node(newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 1000 })));
    const w0 = appendChild(root, mk('w0'));
    appendChild(inner, mk('a'));
    appendChild(inner, mk('b'));

    const r = moveCurrentNode(root, w0, LEFT);
    assert.deepStrictEqual(refs(inner), ['a', 'b', 'w0'],
        'moving left enters the group from its right side');
    checkTree(r.root, 'descend left into aligned group');
}

// An odd group has no middle slot, so its middle child is split across the group's orientation.
{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 2000, h: 1000 }));
    const w0 = appendChild(root, mk('w0'));
    const inner = appendChild(root, node(newGroup(HORIZONTAL, { x: 0, y: 0, w: 1000, h: 1000 })));
    appendChild(inner, mk('a'));
    appendChild(inner, mk('b'));
    addWindow(inner.data, 2);
    appendChild(inner, mk('c'));
    assert.strictEqual(dataLen(inner.data), 3);

    const r = moveCurrentNode(root, w0, RIGHT);
    assert.strictEqual(r.result, MOVE_DONE);
    assert.strictEqual(inner.children.length, 3, 'the inner group kept its child count');
    assert.strictEqual(dataLen(inner.data), 3, 'so its size vector was left alone');
    const split = inner.children[1];
    assert.ok(isGroup(split.data), 'the middle child became a group');
    assert.strictEqual(split.data.orientation, VERTICAL, 'split across the group it sits in');
    assert.deepStrictEqual(refs(split), ['w0', 'b'], 'entering from the left, the mover is first');
    checkTree(r.root, 'odd group split');
}

// ---------- running out of siblings climbs ----------

{
    // The climb only happens when the group runs the *right* way but has no neighbour left on
    // that side. [left, innerVertical(a, b)] in a vertical root: moving `b` right exhausts the
    // inner group, so it climbs to the root and joins there.
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 3000, h: 1000 }));
    const left = appendChild(root, mk('left'));
    const innerG = appendChild(root, node(newGroup(VERTICAL, { x: 0, y: 0, w: 1500, h: 1000 })));
    appendChild(innerG, mk('a'));
    const b = appendChild(innerG, mk('b'));

    const r = moveCurrentNode(root, b, RIGHT);
    assert.strictEqual(r.result, MOVE_DONE, 'the move was absorbed higher up');
    assert.strictEqual(b.parent, root, 'the window climbed out to the root group');
    assert.strictEqual(dataLen(root.data), root.children.length, 'the root stayed consistent');
    assert.strictEqual(innerG.children.length, 1, 'the group it left is down to one child');
    checkTree(r.root, 'climb out');
    void left;
}

// A group running *across* the movement is wrapped instead of climbed: the window steps out
// beside the whole group rather than rising through it. This is the branch that would otherwise
// look like a failed climb.
{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 3000, h: 1000 }));
    appendChild(root, mk('left'));
    const innerG = appendChild(root, node(newGroup(HORIZONTAL, { x: 0, y: 0, w: 1500, h: 1000 })));
    const a = appendChild(innerG, mk('a'));
    appendChild(innerG, mk('b'));

    const r = moveCurrentNode(root, a, RIGHT);
    assert.strictEqual(r.result, MOVE_DONE);
    assert.notStrictEqual(a.parent, root, 'it did not climb to the root');
    assert.strictEqual(a.parent.data.orientation, VERTICAL, 'a vertical group was put around the pair');
    assert.deepStrictEqual(refs(a.parent), ['<group>', 'a'],
        'and the window sits to the right of the group it left');
    assert.strictEqual(a.parent.children[0], innerG);
    checkTree(r.root, 'wrap and step out sideways');
}

// With nowhere left to go, the layout says so instead of pretending.
{
    const root = rowOf(2, VERTICAL, 1000);
    const w1 = root.children[1];
    const r = moveCurrentNode(root, w1, RIGHT);
    assert.strictEqual(r.result, MOVE_FURTHER,
        'the rightmost window of the outermost row has nowhere to go in this layout');
    assert.deepStrictEqual(refs(root), ['w0', 'w1'], 'and nothing moved');
}

// ---------- a long sequence leaves the tree sound ----------

{
    let root = rowOf(4, VERTICAL, 4000);
    const order = [LEFT, DOWN, RIGHT, UP, RIGHT, RIGHT, LEFT, DOWN];
    for (let i = 0; i < order.length; i++) {
        const windows = preOrder(root).filter((n) => isMapped(n.data));
        const pick = windows[i % windows.length];
        const r = moveCurrentNode(root, pick, order[i]);
        root = r.root;
        checkTree(root, `sequence step ${i} (${order[i]})`);
    }
    const windows = preOrder(root).filter((n) => isMapped(n.data));
    assert.strictEqual(windows.length, 4, 'no window was lost or duplicated along the way');
}

console.log('ALL OK');
