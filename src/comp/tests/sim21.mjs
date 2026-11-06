// Mirrors cosmic-comp move_current_node :1507. A mover enters a cell from the side it came from,
// so Left/Up land at index 1: the opposite of a window arriving from another output.
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

// A move that leaves the tree inconsistent is a bug even when the window landed correctly.
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

{
    const r = moveCurrentNode(null, null, LEFT);
    assert.strictEqual(r.result, MOVE_NONE);
}

{
    const a = mk('a');
    const r = moveCurrentNode(a, a, LEFT);
    assert.strictEqual(r.result, MOVE_FURTHER, 'a single window asks the caller to take it');
    assert.strictEqual(r.root, a);
}

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

{
    const root = rowOf(2, VERTICAL, 1000);
    root.data.sizes = [700, 300];
    const w0 = root.children[0];
    moveCurrentNode(root, w0, RIGHT);
    moveCurrentNode(root, w0, LEFT);
    assert.deepStrictEqual(refs(root), ['w0', 'w1']);
    assert.deepStrictEqual(root.data.sizes, [700, 300], 'back exactly where it started');
}

{
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

{
    const root = rowOf(3, VERTICAL, 3000);
    const [w0, w1, w2] = root.children;

    const r = moveCurrentNode(root, w0, RIGHT);
    assert.strictEqual(r.result, MOVE_DONE);
    assert.strictEqual(root.children.length, 2, 'the row lost a child to the new group');
    assert.strictEqual(dataLen(root.data), 2, 'and its size vector shrank with it');
    assert.strictEqual(sum(root.data.sizes), 3000);

    const g = root.children[0];
    assert.ok(isGroup(g.data), 'w1 was replaced in place by a group');
    assert.strictEqual(g.data.orientation, VERTICAL);
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

{
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

{
    // Climbing only happens when the group runs along the move but has no neighbour left on that side.
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

// A group running across the move is wrapped, not climbed; otherwise this looks like a failed climb.
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

{
    const root = rowOf(2, VERTICAL, 1000);
    const w1 = root.children[1];
    const r = moveCurrentNode(root, w1, RIGHT);
    assert.strictEqual(r.result, MOVE_FURTHER,
        'the rightmost window of the outermost row has nowhere to go in this layout');
    assert.deepStrictEqual(refs(root), ['w0', 'w1'], 'and nothing moved');
}

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
