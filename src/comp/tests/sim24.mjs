// Stacks: toggle_stacking :2132 and CosmicStack::handle_move (element/stack.rs :432).
//
// A stack is a kind of leaf, not a tree node and not a side table hung off one. Upstream it is
// CosmicStack, which is a kind of *window* — the tree never sees the difference. So the headline
// assertion here is structural: stacking and unstacking change the leaf, and only dissolving a
// stack or ejecting from one is allowed to change the tree's shape.
//
// Also pinned down:
//   - `stacked` is a flag, not windows.length > 1: a stack of one is still a stack, which is
//     what lets you convert a lone window and then drop others onto it
//   - Left and Right move the active window within the tab order, carrying it with them
//   - Up and Down never move inside a stack, and neither does running off either end: all eject
//   - a stack of one declines the move entirely, so it travels like an ordinary window
//   - dissolving a stack of four gives four tiled windows, each splitting the last — not four
//     siblings in one group
//   - `ref` always names the active window, because that is the one whose geometry gets written
//
import assert from 'node:assert';
import path from 'node:path';

const tiler = process.argv[2];
const core = await import(path.join(path.dirname(tiler), 'core.mjs'));
const {
    VERTICAL, LEFT, RIGHT, UP, DOWN,
    newGroup, newMapped, addWindow, isMapped, isGroup, dataLen,
    node, appendChild, preOrder, measure, indexIn,
    isStack, convertToStack, stackAdd, stackSetActive, stackCycle,
    handleStackMove, STACK_HANDLED, STACK_MOVE_OUT, STACK_DEFAULT,
    toggleStacking, moveCurrentNode, MOVE_DONE,
} = core;

const AREA = { x: 0, y: 0, w: 2000, h: 1000 };
const GAPS = { outer: 8, inner: 8 };
const mk = (ref) => node(newMapped(ref));
const sum = (a) => a.reduce((x, y) => x + y, 0);

function checkTree(root, label) {
    for (const n of preOrder(root)) {
        for (const c of n.children) assert.strictEqual(c.parent, n, `${label}: bad parent link`);
        if (isGroup(n.data)) {
            assert.strictEqual(n.children.length, dataLen(n.data),
                `${label}: ${n.children.length} children, ${dataLen(n.data)} sizes`);
        }
        if (isMapped(n.data)) {
            assert.strictEqual(n.data.ref, n.data.windows[n.data.active],
                `${label}: ref does not name the active window`);
        }
    }
}

function stackOf(refs) {
    const n = mk(refs[0]);
    convertToStack(n.data);
    stackAdd(n.data, refs.slice(1), null);
    return n;
}

// ---------- a leaf is a stack of one until told otherwise ----------

{
    const n = mk('a');
    assert.deepStrictEqual(n.data.windows, ['a']);
    assert.strictEqual(n.data.active, 0);
    assert.strictEqual(isStack(n.data), false, 'a plain window is not a stack');
    assert.strictEqual(n.data.ref, 'a');
}

// A stack of one is still a stack. This is why `stacked` is a flag rather than a count: it is
// what lets a lone window be converted and then have others dropped onto it.
{
    const n = mk('a');
    convertToStack(n.data);
    assert.ok(isStack(n.data));
    assert.strictEqual(n.data.windows.length, 1);
}

// ---------- the active window is what `ref` names ----------

{
    const n = stackOf(['a', 'b', 'c']);
    assert.strictEqual(n.data.ref, 'a');
    stackSetActive(n.data, 2);
    assert.strictEqual(n.data.ref, 'c', 'ref follows the active index');

    stackSetActive(n.data, 99);
    assert.strictEqual(n.data.active, 2, 'an out-of-range index is clamped, not stored');
    assert.strictEqual(n.data.ref, 'c');
}

// Tabbing is clamped rather than wrapped: running off the end is what ejects, so wrapping here
// would make ejection unreachable.
{
    const n = stackOf(['a', 'b', 'c']);
    assert.ok(stackCycle(n.data, 1));
    assert.strictEqual(n.data.ref, 'b');
    assert.ok(stackCycle(n.data, 1));
    assert.strictEqual(n.data.ref, 'c');
    assert.strictEqual(stackCycle(n.data, 1), false, 'no wrap past the end');
    assert.strictEqual(n.data.ref, 'c', 'and the active window did not move');
    assert.strictEqual(stackCycle(n.data, -5), false, 'nor past the start');
}

// ---------- adding ----------

{
    const n = stackOf(['a', 'b']);
    stackAdd(n.data, 'c', null);
    assert.deepStrictEqual(n.data.windows, ['a', 'b', 'c'], 'null appends');
    stackAdd(n.data, 'z', 0);
    assert.deepStrictEqual(n.data.windows, ['z', 'a', 'b', 'c'], 'an index inserts');
    assert.strictEqual(n.data.ref, 'z', 'and the active index still names a real window');
}

// ---------- toggling a window into a stack does not move the node ----------

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    const a = appendChild(root, mk('a'));
    appendChild(root, mk('b'));
    measure(root, AREA, GAPS);

    const idxBefore = indexIn(root, a);
    const r = toggleStacking(root, a, AREA);

    assert.strictEqual(r.root, root, 'the root did not move');
    assert.strictEqual(root.children.length, 2, 'no node was added');
    assert.strictEqual(indexIn(root, a), idxBefore, 'and the leaf stayed where it was');
    assert.ok(isStack(a.data), 'the leaf is now a stack');
    assert.deepStrictEqual(a.data.windows, ['a']);
    checkTree(r.root, 'toggle into a stack');
}

// ---------- dissolving a stack spreads it through the tree ----------

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    const s = appendChild(root, stackOf(['a', 'b', 'c', 'd']));
    appendChild(root, mk('other'));
    measure(root, AREA, GAPS);

    const r = toggleStacking(root, s, AREA);
    checkTree(r.root, 'dissolve');

    assert.strictEqual(isStack(s.data), false, 'the leaf is a plain window again');
    assert.deepStrictEqual(s.data.windows, ['a'], 'holding the first window');

    const windows = preOrder(r.root).filter((n) => isMapped(n.data)).map((n) => n.data.ref);
    assert.deepStrictEqual(windows.sort(), ['a', 'b', 'c', 'd', 'other'],
        'all four are in the tree, none lost or duplicated');

    // Each of the rest split the previous one, so they are nested rather than siblings in one
    // row. The giveaway is that no single group holds all four.
    const groups = preOrder(r.root).filter((n) => isGroup(n.data));
    for (const g of groups) {
        const leaves = g.children.filter((c) => isMapped(c.data)).map((c) => c.data.ref);
        assert.ok(leaves.length < 4, 'no group holds the whole dissolved stack as one row');
    }

    const { configures } = measure(r.root, AREA, GAPS);
    assert.strictEqual(configures.length, 5, 'every window measures');
    for (const c of configures) assert.ok(c.geo.w > 0 && c.geo.h > 0);
}

// Dissolving a stack of one leaves a plain window and changes nothing else.
{
    const only = mk('a');
    convertToStack(only.data);
    const r = toggleStacking(only, only, AREA);
    assert.strictEqual(r.root, only);
    assert.strictEqual(isStack(only.data), false);
    assert.deepStrictEqual(only.data.windows, ['a']);
}

// ---------- handle_move inside a stack ----------

{
    const n = stackOf(['a', 'b', 'c']);
    stackSetActive(n.data, 1);          // 'b' is active

    const r = handleStackMove(n.data, RIGHT);
    assert.strictEqual(r.result, STACK_HANDLED);
    assert.deepStrictEqual(n.data.windows, ['a', 'c', 'b'],
        'the active window swapped with its neighbour, carrying its place in the tab order');
    assert.strictEqual(n.data.ref, 'b', 'and it is still the active one');
    assert.strictEqual(n.data.active, 2);
}

{
    const n = stackOf(['a', 'b', 'c']);
    stackSetActive(n.data, 1);
    handleStackMove(n.data, LEFT);
    assert.deepStrictEqual(n.data.windows, ['b', 'a', 'c']);
    assert.strictEqual(n.data.ref, 'b');
}

// Up and Down never move inside a stack — they eject.
{
    for (const dir of [UP, DOWN]) {
        const n = stackOf(['a', 'b', 'c']);
        stackSetActive(n.data, 1);
        const r = handleStackMove(n.data, dir);
        assert.strictEqual(r.result, STACK_MOVE_OUT, `${dir} ejects rather than tabbing`);
        assert.strictEqual(r.ref, 'b');
        assert.deepStrictEqual(n.data.windows, ['a', 'c']);
    }
}

// Running off either end ejects too.
{
    const n = stackOf(['a', 'b']);
    stackSetActive(n.data, 0);
    const r = handleStackMove(n.data, LEFT);
    assert.strictEqual(r.result, STACK_MOVE_OUT, 'nothing to the left inside the stack');
    assert.strictEqual(r.ref, 'a');
    assert.deepStrictEqual(n.data.windows, ['b']);
    assert.strictEqual(n.data.ref, 'b', 'the survivor became active');
}

// Ejecting the last window steps the active index back; ejecting from the middle leaves it
// pointing at what used to be the next window along.
{
    const n = stackOf(['a', 'b', 'c']);
    stackSetActive(n.data, 2);
    handleStackMove(n.data, RIGHT);
    assert.deepStrictEqual(n.data.windows, ['a', 'b']);
    assert.strictEqual(n.data.ref, 'b', 'stepped back to the new last window');
}
{
    const n = stackOf(['a', 'b', 'c']);
    stackSetActive(n.data, 0);
    handleStackMove(n.data, UP);
    assert.deepStrictEqual(n.data.windows, ['b', 'c']);
    assert.strictEqual(n.data.ref, 'b', 'the index stayed and now names the next one along');
}

// A stack of one declines, so it travels like an ordinary window.
{
    const n = stackOf(['a']);
    for (const dir of [LEFT, RIGHT, UP, DOWN]) {
        assert.strictEqual(handleStackMove(n.data, dir).result, STACK_DEFAULT,
            `a stack of one declines ${dir}`);
        assert.deepStrictEqual(n.data.windows, ['a'], 'and keeps its window');
    }
}

// A plain window is not asked at all.
{
    const n = mk('a');
    assert.strictEqual(handleStackMove(n.data, LEFT).result, STACK_DEFAULT);
}

// ---------- moving a stack through the tree ----------

// A move that the stack handles never reaches the tree.
{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    const s = appendChild(root, stackOf(['a', 'b']));
    appendChild(root, mk('other'));
    measure(root, AREA, GAPS);

    const r = moveCurrentNode(root, s, RIGHT);
    assert.strictEqual(r.result, MOVE_DONE);
    assert.strictEqual(r.root, root, 'the tree is untouched');
    assert.strictEqual(root.children.length, 2);
    assert.deepStrictEqual(s.data.windows, ['b', 'a'], 'the stack reordered itself instead');
}

// A move the stack rejects ejects into the tree beside it.
{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    const s = appendChild(root, stackOf(['a', 'b']));
    appendChild(root, mk('other'));
    measure(root, AREA, GAPS);
    stackSetActive(s.data, 0);

    const r = moveCurrentNode(root, s, UP);
    assert.strictEqual(r.result, MOVE_DONE);
    assert.deepStrictEqual(s.data.windows, ['b'], 'the window left the stack');
    assert.ok(r.shiftFocus, 'and the caller is told to follow it');
    assert.strictEqual(r.shiftFocus.data.ref, 'a');
    assert.strictEqual(r.shiftFocus.parent.data.orientation, 'horizontal',
        'ejected upwards, so the pair is split by a horizontal line');
    assert.strictEqual(indexIn(r.shiftFocus.parent, r.shiftFocus), 0, 'and it went above');
    checkTree(r.root, 'eject upward');
}

// ---------- moving a window into a neighbouring stack joins it ----------

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    const w = appendChild(root, mk('w'));
    const s = appendChild(root, stackOf(['a', 'b']));
    measure(root, AREA, GAPS);

    const r = moveCurrentNode(root, w, RIGHT);
    assert.strictEqual(r.result, MOVE_DONE);
    assert.strictEqual(r.shiftFocus, s, 'focus follows the window into the stack');
    assert.deepStrictEqual(s.data.windows, ['w', 'a', 'b'],
        'pushed in from the left, it lands ahead of what was there');
    assert.strictEqual(root.children.length, 1, 'the row lost the window it gave away');
    checkTree(r.root, 'join a stack by moving');
}

{
    // From the other side it goes on the end.
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    const s = appendChild(root, stackOf(['a', 'b']));
    const w = appendChild(root, mk('w'));
    measure(root, AREA, GAPS);

    moveCurrentNode(root, w, LEFT);
    assert.deepStrictEqual(s.data.windows, ['a', 'b', 'w']);
}

// With more than two siblings the window has somewhere of its own to go, and upstream prefers
// that over joining the stack.
{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    const w = appendChild(root, mk('w'));
    const s = appendChild(root, stackOf(['a', 'b']));
    addWindow(root.data, 2);
    appendChild(root, mk('third'));
    measure(root, AREA, GAPS);

    const r = moveCurrentNode(root, w, RIGHT);
    assert.deepStrictEqual(s.data.windows, ['a', 'b'], 'the stack was split, not joined');
    checkTree(r.root, 'three siblings prefer a split');
}

// A stack does not swallow another stack by moving.
{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    const s1 = appendChild(root, stackOf(['x']));
    const s2 = appendChild(root, stackOf(['a', 'b']));
    measure(root, AREA, GAPS);

    // s1 is a stack of one, so handleStackMove declines and it travels as a window — but it is
    // still a stack, so the join branch does not take it.
    const r = moveCurrentNode(root, s1, RIGHT);
    assert.deepStrictEqual(s2.data.windows, ['a', 'b'], 'the target stack is unchanged');
    checkTree(r.root, 'stack does not join a stack');
}

// ---------- the row stays exact through all of it ----------

{
    const root = node(newGroup(VERTICAL, { x: 0, y: 0, w: AREA.w, h: AREA.h }));
    appendChild(root, mk('w0'));
    appendChild(root, stackOf(['a', 'b', 'c']));
    addWindow(root.data, 2);
    appendChild(root, mk('w2'));
    measure(root, AREA, GAPS);

    assert.strictEqual(sum(root.data.sizes), AREA.w - GAPS.outer * 2,
        'a stack takes exactly one slot, however many windows it holds');
    const { configures } = measure(root, AREA, GAPS);
    assert.strictEqual(configures.length, 3, 'and measures as one window');
}

console.log('ALL OK');
