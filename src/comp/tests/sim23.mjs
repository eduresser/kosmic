// Mirrors cosmic-comp src/shell/layout/floating/ and workspace.rs.
import assert from 'node:assert';
import path from 'node:path';

const tiler = process.argv[2];
const core = await import(path.join(path.dirname(tiler), 'core.mjs'));
const {
    VERTICAL, isMapped,
    newGroup, newMapped, addWindow, node, appendChild, measure, preOrder,
    TILED_TOP, TILED_BOTTOM, TILED_LEFT, TILED_RIGHT,
    TILED_TOP_LEFT, TILED_TOP_RIGHT, TILED_BOTTOM_LEFT, TILED_BOTTOM_RIGHT,
    cornerGeometry, floatingSize,
    newWorkspace, findMapped, floatingIndex, mapFloating, unmapFloating,
    toggleFloatingWindow, setTilingEnabled,
} = core;

const WORK = { x: 0, y: 0, w: 2000, h: 1000 };
const GAPS = { outer: 8, inner: 8 };
const mk = (ref) => node(newMapped(ref));

{
    const left = cornerGeometry(TILED_LEFT, WORK, GAPS);
    const right = cornerGeometry(TILED_RIGHT, WORK, GAPS);

    // Same seam rule as the tiling layout, so a snapped pair and a tiled pair look identical.
    const seam = right.x - (left.x + left.w);
    assert.strictEqual(seam, GAPS.inner, 'two snapped halves are one inner gap apart');

    assert.strictEqual(left.x - WORK.x, GAPS.inner);
    assert.strictEqual((WORK.x + WORK.w) - (right.x + right.w), GAPS.inner);
    assert.strictEqual(left.w, right.w, 'the halves are the same width');
    assert.strictEqual(left.h, right.h);
    assert.strictEqual(left.y, WORK.y + GAPS.inner, 'a left half is full height');
    assert.strictEqual(left.h, WORK.h - GAPS.inner * 2);
}

{
    const top = cornerGeometry(TILED_TOP, WORK, GAPS);
    const bottom = cornerGeometry(TILED_BOTTOM, WORK, GAPS);
    const seam = bottom.y - (top.y + top.h);
    assert.strictEqual(seam, GAPS.inner, 'the horizontal seam matches too');
    assert.strictEqual(top.w, WORK.w - GAPS.inner * 2, 'a top half is full width');
    assert.strictEqual(top.x, bottom.x);
}

{
    const tl = cornerGeometry(TILED_TOP_LEFT, WORK, GAPS);
    const tr = cornerGeometry(TILED_TOP_RIGHT, WORK, GAPS);
    const bl = cornerGeometry(TILED_BOTTOM_LEFT, WORK, GAPS);
    const br = cornerGeometry(TILED_BOTTOM_RIGHT, WORK, GAPS);

    assert.strictEqual(tr.x - (tl.x + tl.w), GAPS.inner, 'top seam');
    assert.strictEqual(br.x - (bl.x + bl.w), GAPS.inner, 'bottom seam');
    assert.strictEqual(bl.y - (tl.y + tl.h), GAPS.inner, 'left seam');
    assert.strictEqual(br.y - (tr.y + tr.h), GAPS.inner, 'right seam');

    for (const [name, r] of [['tl', tl], ['tr', tr], ['bl', bl], ['br', br]]) {
        assert.strictEqual(r.w, tl.w, `${name} is the same width as the others`);
        assert.strictEqual(r.h, tl.h, `${name} is the same height`);
        assert.ok(r.x >= WORK.x && r.y >= WORK.y, `${name} starts inside the work area`);
        assert.ok(r.x + r.w <= WORK.x + WORK.w, `${name} ends inside it`);
        assert.ok(r.y + r.h <= WORK.y + WORK.h);
    }

    assert.strictEqual(tl.w, cornerGeometry(TILED_LEFT, WORK, GAPS).w, 'a corner is half-width');
    assert.strictEqual(tl.h, cornerGeometry(TILED_TOP, WORK, GAPS).h, 'and half-height');
}

{
    const off = { x: 100, y: 50, w: 2000, h: 1000 };
    const a = cornerGeometry(TILED_TOP_RIGHT, WORK, GAPS);
    const b = cornerGeometry(TILED_TOP_RIGHT, off, GAPS);
    assert.strictEqual(b.x - a.x, 100);
    assert.strictEqual(b.y - a.y, 50);
    assert.strictEqual(b.w, a.w);
    assert.strictEqual(b.h, a.h);
}

assert.strictEqual(cornerGeometry('nonsense', WORK, GAPS), null);

{
    const s = floatingSize({ w: 1900, h: 950 }, WORK, { w: 320, h: 240 }, null);
    assert.strictEqual(s.w, Math.trunc(WORK.w / 3) * 2, 'two thirds, with the division first');
    assert.strictEqual(s.h, Math.trunc(WORK.h / 3) * 2);
}

{
    const s = floatingSize({ w: 800, h: 600 }, WORK, { w: 320, h: 240 }, null);
    assert.deepStrictEqual(s, { w: 800, h: 600 }, 'nothing to clamp');
}

{
    const s = floatingSize({ w: 1900, h: 950 }, WORK, { w: 1800, h: 900 }, null);
    assert.strictEqual(s.w, 1800, 'never cut below the window minimum');
    assert.strictEqual(s.h, 900);
}

{
    const s = floatingSize({ w: 1900, h: 950 }, WORK, { w: 320, h: 240 }, { w: 500, h: 400 });
    assert.strictEqual(s.w, 500);
    assert.strictEqual(s.h, 400);
}

{
    const s = floatingSize({ w: 9000, h: 9000 }, WORK, { w: 8000, h: 8000 }, { w: 9999, h: 9999 });
    assert.strictEqual(s.w, WORK.w, 'the work area is the last word');
    assert.strictEqual(s.h, WORK.h);
}

function wsWithTiled(n) {
    const ws = newWorkspace();
    ws.tiling = node(newGroup(VERTICAL, { x: 0, y: 0, w: WORK.w, h: WORK.h }));
    appendChild(ws.tiling, mk('w0'));
    appendChild(ws.tiling, mk('w1'));
    for (let i = 2; i < n; i++) {
        addWindow(ws.tiling.data, i);
        appendChild(ws.tiling, mk('w' + i));
    }
    measure(ws.tiling, WORK, GAPS);
    return ws;
}

{
    const ws = newWorkspace();
    assert.strictEqual(ws.tiling, null);
    assert.deepStrictEqual(ws.floating, []);
    assert.strictEqual(ws.tilingEnabled, true);
}

{
    const ws = wsWithTiled(3);
    const before = { ...findMapped(ws.tiling, 'w1').data.geo };

    assert.ok(toggleFloatingWindow(ws, 'w1', WORK, null));
    assert.strictEqual(findMapped(ws.tiling, 'w1'), null, 'it left the tree');
    assert.strictEqual(floatingIndex(ws, 'w1'), 0, 'and arrived in the floating layer');
    assert.deepStrictEqual(ws.floating[0].geo, before,
        'carrying the rectangle it had while tiled');

    const stillTiled = preOrder(ws.tiling).filter((n) => isMapped(n.data)).map((n) => n.data.ref);
    assert.deepStrictEqual(stillTiled.sort(), ['w0', 'w2'], 'the others stayed');
}

{
    const ws = wsWithTiled(3);
    toggleFloatingWindow(ws, 'w1', WORK, null);
    assert.ok(toggleFloatingWindow(ws, 'w1', WORK, 'w0'));
    assert.ok(findMapped(ws.tiling, 'w1'), 'it is tiled again');
    assert.strictEqual(floatingIndex(ws, 'w1'), -1, 'and gone from the floating layer');
}

{
    const ws = wsWithTiled(3);
    toggleFloatingWindow(ws, 'w1', WORK, null);
    const floated = { ...ws.floating[0].geo };

    ws.floating[0].geo = { x: 700, y: 300, w: 400, h: 250 };
    toggleFloatingWindow(ws, 'w1', WORK, 'w0');
    measure(ws.tiling, WORK, GAPS);
    toggleFloatingWindow(ws, 'w1', WORK, null);

    assert.deepStrictEqual(ws.floating[0].geo, { x: 700, y: 300, w: 400, h: 250 },
        'the floating layer remembered where it was, not where it was tiled');
    assert.notDeepStrictEqual(ws.floating[0].geo, floated);
}

{
    const ws = wsWithTiled(2);
    assert.strictEqual(toggleFloatingWindow(ws, 'nope', WORK, null), false);
}

// Upstream guards on this: with everything floating there is no distinction to toggle.
{
    const ws = wsWithTiled(2);
    setTilingEnabled(ws, false, WORK);
    const before = ws.floating.map((f) => f.ref).sort();
    assert.strictEqual(toggleFloatingWindow(ws, 'w0', WORK, null), false);
    assert.deepStrictEqual(ws.floating.map((f) => f.ref).sort(), before, 'nothing moved');
}

{
    const ws = wsWithTiled(3);
    setTilingEnabled(ws, false, WORK);

    assert.strictEqual(ws.tilingEnabled, false);
    assert.strictEqual(ws.tiling, null, 'no tree is left behind');
    assert.deepStrictEqual(ws.floating.map((f) => f.ref).sort(), ['w0', 'w1', 'w2'],
        'every window crossed over');
    for (const f of ws.floating) {
        assert.ok(f.geo.w > 0 && f.geo.h > 0, `${f.ref} kept a real rectangle`);
    }
}

{
    const ws = wsWithTiled(3);
    setTilingEnabled(ws, false, WORK);
    setTilingEnabled(ws, true, WORK);

    assert.strictEqual(ws.tilingEnabled, true);
    assert.deepStrictEqual(ws.floating, [], 'the floating layer is empty again');
    const back = preOrder(ws.tiling).filter((n) => isMapped(n.data)).map((n) => n.data.ref);
    assert.deepStrictEqual(back.sort(), ['w0', 'w1', 'w2'], 'and all three are tiled');

    const { configures } = measure(ws.tiling, WORK, GAPS);
    assert.strictEqual(configures.length, 3, 'the rebuilt tree measures all three');
    for (const c of configures) assert.ok(c.geo.w > 0 && c.geo.h > 0);
}

{
    const ws = wsWithTiled(2);
    const root = ws.tiling;
    setTilingEnabled(ws, true, WORK);
    assert.strictEqual(ws.tiling, root, 'the tree was not touched');
}

{
    const ws = newWorkspace();
    mapFloating(ws, 'a', { x: 10, y: 20, w: 300, h: 200 });
    assert.strictEqual(floatingIndex(ws, 'a'), 0);

    const geo = unmapFloating(ws, 'a');
    assert.deepStrictEqual(geo, { x: 10, y: 20, w: 300, h: 200 }, 'unmap hands back the rect');
    assert.strictEqual(floatingIndex(ws, 'a'), -1);

    mapFloating(ws, 'a', null);
    assert.deepStrictEqual(ws.floating[0].geo, { x: 10, y: 20, w: 300, h: 200 },
        'no position means the one it had last time');

    assert.strictEqual(unmapFloating(ws, 'missing'), null);
}

console.log('ALL OK');
