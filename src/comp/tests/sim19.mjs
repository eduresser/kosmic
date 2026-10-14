// Insertion and removal on the N-ary tree: map_to_tree :548 and unmap_internal :1446.
//
// The behaviour this pins down, and the reason each one is easy to get wrong:
//   - a new window splits the *focused* window, and the orientation comes from that window's
//     aspect, not from a fixed axis or from the output
//   - the newcomer is the second child, so a split puts it right of or below what was there
//   - a direction reads backwards: a window moved left arrives at the left output's right edge
//   - removing from a group of three redistributes through remove_window, but removing from a
//     group of two *dissolves* the group and hands the survivor the whole rectangle, discarding
//     the size vector rather than fixing it up
//
import assert from 'node:assert';
import path from 'node:path';

const tiler = process.argv[2];
const core = await import(path.join(path.dirname(tiler), 'core.mjs'));
const {
    HORIZONTAL, VERTICAL, LEFT, RIGHT, UP, DOWN,
    newGroup, newMapped, addWindow, dataLen, isGroup, isMapped,
    node, appendChild, indexIn, measure,
    mapToTree, unmapInternal, newGroupAround, orientationFor, indexForDirection,
} = core;

const sum = (a) => a.reduce((x, y) => x + y, 0);
const refs = (n) => n.children.map((c) => (isMapped(c.data) ? c.data.ref : '<group>'));
const mk = (ref, geo) => node(newMapped(ref, geo || { x: 0, y: 0, w: 0, h: 0 }));

// ---------- orientation comes from the aspect of the thing being split ----------

assert.strictEqual(orientationFor({ w: 1000, h: 800 }), VERTICAL, 'wide splits with a vertical line');
assert.strictEqual(orientationFor({ w: 800, h: 1000 }), HORIZONTAL, 'tall splits with a horizontal line');
assert.strictEqual(orientationFor({ w: 500, h: 500 }), HORIZONTAL, 'a square is not wider than tall');

// ---------- an empty tree ----------

{
    const a = mk('a');
    const root = mapToTree(null, a, null, null, { w: 1000, h: 800 });
    assert.strictEqual(root, a, 'the first window is the root, with no group around it');
    assert.strictEqual(root.children.length, 0);
}

// ---------- the second window splits the focused one ----------

{
    const a = mk('a', { x: 0, y: 0, w: 1000, h: 800 });
    const b = mk('b');
    const root = mapToTree(a, b, a, null, { w: 1000, h: 800 });

    assert.ok(isGroup(root.data), 'a group now sits where the focused window was');
    assert.strictEqual(root.data.orientation, VERTICAL, 'the focused window was wide');
    assert.deepStrictEqual(refs(root), ['a', 'b'], 'the newcomer is the second child');
    assert.strictEqual(indexIn(root, b), 1);
}

// A tall focused window splits the other way.
{
    const a = mk('a', { x: 0, y: 0, w: 800, h: 1000 });
    const root = mapToTree(a, mk('b'), a, null, { w: 1000, h: 800 });
    assert.strictEqual(root.data.orientation, HORIZONTAL,
        'the orientation follows the focused window, not the output');
}

// ---------- splitting a focused window deeper in the tree leaves the root alone ----------

{
    const a = mk('a', { x: 0, y: 0, w: 500, h: 800 });
    const b = mk('b', { x: 0, y: 0, w: 500, h: 800 });
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 800 }));
    appendChild(root, a);
    appendChild(root, b);

    const after = mapToTree(root, mk('c'), b, null, { w: 1000, h: 800 });
    assert.strictEqual(after, root, 'the root does not move when the split is below it');
    assert.strictEqual(root.children.length, 2, 'and it still has two children');
    const inner = root.children[1];
    assert.ok(isGroup(inner.data), 'b was replaced in place by a group');
    assert.strictEqual(inner.data.orientation, HORIZONTAL, 'b was taller than wide');
    assert.deepStrictEqual(refs(inner), ['b', 'c']);
}

// ---------- a direction reads backwards on purpose ----------

assert.strictEqual(indexForDirection(LEFT), 1, 'moved left, so it arrives at the right edge');
assert.strictEqual(indexForDirection(UP), 1);
assert.strictEqual(indexForDirection(RIGHT), 0);
assert.strictEqual(indexForDirection(DOWN), 0);

{
    const a = mk('a', { x: 0, y: 0, w: 1000, h: 800 });
    const root = mapToTree(a, mk('b'), null, LEFT, { w: 1000, h: 800 });
    assert.strictEqual(root.data.orientation, VERTICAL, 'left/right split with a vertical line');
    assert.deepStrictEqual(refs(root), ['a', 'b'], 'travelling left lands it after what was there');
}
{
    const a = mk('a', { x: 0, y: 0, w: 1000, h: 800 });
    const root = mapToTree(a, mk('b'), null, RIGHT, { w: 1000, h: 800 });
    assert.deepStrictEqual(refs(root), ['b', 'a'], 'travelling right lands it before');
}
{
    const a = mk('a', { x: 0, y: 0, w: 1000, h: 800 });
    const root = mapToTree(a, mk('b'), null, DOWN, { w: 1000, h: 800 });
    assert.strictEqual(root.data.orientation, HORIZONTAL, 'up/down split with a horizontal line');
}

// ---------- no focus falls back to the output's aspect ----------

{
    const a = mk('a', { x: 0, y: 0, w: 100, h: 900 });
    const root = mapToTree(a, mk('b'), null, null, { w: 1920, h: 1080 });
    assert.strictEqual(root.data.orientation, VERTICAL,
        'with nothing focused the output decides, and this one is wide');
}

// ---------- removing from a group of three redistributes ----------

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 800 }));
    const a = appendChild(root, mk('a'));
    const b = appendChild(root, mk('b'));
    addWindow(root.data, 2);
    const c = appendChild(root, mk('c'));
    assert.strictEqual(dataLen(root.data), 3);
    assert.strictEqual(sum(root.data.sizes), 1000);

    const after = unmapInternal(root, b);
    assert.strictEqual(after, root, 'the root survives');
    assert.strictEqual(dataLen(root.data), 2, 'the size vector shrank with the children');
    assert.strictEqual(root.children.length, 2);
    assert.deepStrictEqual(refs(root), ['a', 'c']);
    assert.strictEqual(sum(root.data.sizes), 1000,
        'and still sums to the group length, so the row has no hole in it');
    void a; void c;
}

// ---------- removing from a group of two dissolves the group ----------

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 800 }));
    const inner = appendChild(root, node(newGroup(HORIZONTAL, { x: 0, y: 0, w: 500, h: 800 })));
    const other = appendChild(root, mk('other'));
    const a = appendChild(inner, mk('a'));
    const b = appendChild(inner, mk('b'));

    const after = unmapInternal(root, a);
    assert.strictEqual(after, root);
    assert.strictEqual(root.children.length, 2, 'the root still has two children');
    assert.deepStrictEqual(refs(root), ['b', 'other'],
        'the group is gone and its survivor took its index, not the end of the row');
    assert.strictEqual(b.parent, root, 'the survivor was reparented');
    assert.strictEqual(dataLen(root.data), 2, "the root's own size vector is untouched");
    void inner; void other;
}

// The survivor ends up with the whole rectangle the group had. This does not by itself prove the
// group was dissolved — measure flattens a one-child group anyway, so the other path would reach
// the same geometry. The structural assertions above are what distinguish them; this one records
// the outcome a user actually sees.
{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 800 }));
    const inner = appendChild(root, node(newGroup(HORIZONTAL, { x: 0, y: 0, w: 500, h: 800 })));
    appendChild(root, mk('other'));
    const a = appendChild(inner, mk('a'));
    appendChild(inner, mk('b'));

    unmapInternal(root, a);
    const { configures } = measure(root, { x: 0, y: 0, w: 1000, h: 800 }, { outer: 8, inner: 8 });
    const by = Object.fromEntries(configures.map((c) => [c.node.data.ref, c.geo]));
    assert.strictEqual(by.b.h, by.other.h,
        'the survivor is as tall as its new sibling, not half as tall');
}

// ---------- removing the last child of the root ----------

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 1000, h: 800 }));
    const a = appendChild(root, mk('a'));
    const b = appendChild(root, mk('b'));

    const after = unmapInternal(root, a);
    assert.strictEqual(after, b, 'dissolving the root group promotes the survivor to root');
    assert.strictEqual(b.parent, null, 'and it has no parent left');
    void a;
}

// A lone root has no parent to fix up and leaves nothing behind.
{
    const a = mk('a');
    assert.strictEqual(unmapInternal(a, a), null, 'removing the only window empties the tree');
}

// ---------- map then unmap is a round trip ----------

{
    const a = mk('a', { x: 0, y: 0, w: 1000, h: 800 });
    const b = mk('b');
    const root = mapToTree(a, b, a, null, { w: 1000, h: 800 });
    const after = unmapInternal(root, b);
    assert.strictEqual(after, a, 'the tree is back to the single window it started as');
    assert.strictEqual(a.parent, null);
}

// ---------- newGroupAround keeps the target's index ----------

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: 900, h: 800 }));
    const a = appendChild(root, mk('a'));
    const b = appendChild(root, mk('b', { x: 0, y: 0, w: 300, h: 800 }));
    const c = appendChild(root, mk('c'));

    const g = newGroupAround(b, mk('d'), HORIZONTAL);
    assert.strictEqual(indexIn(root, g), 1, 'the group took the target index, between a and c');
    assert.deepStrictEqual(refs(root), ['a', '<group>', 'c']);
    assert.deepStrictEqual(refs(g), ['b', 'd']);
    void a; void c;
}

console.log('ALL OK');
