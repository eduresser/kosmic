// SPDX-FileCopyrightText: 2024 System76, Inc. <info@system76.com>

// References are pop-os/cosmic-comp, src/shell/layout/tiling/mod.rs.
// Line numbers drift; the symbol names do not.

// Rust's integer casts, not JS's: a wrong one drifts a pixel at a time until a row stops summing.

export function idiv(a, b) { return Math.trunc(a / b); }

// f64::round ties away from zero (Math.round: toward +Infinity) and `as i32` maps NaN to 0,
// which remove_window relies on when it divides by a zero remainder.
export function roundI32(x) {
    if (Number.isNaN(x)) return 0;
    if (x === Infinity) return 2147483647;
    if (x === -Infinity) return -2147483648;
    const r = x < 0 ? -Math.round(-x) : Math.round(x);
    if (r > 2147483647) return 2147483647;
    if (r < -2147483648) return -2147483648;
    return r;
}

// Named for the dividing line, not the run direction: Horizontal splits height, children run top
// to bottom (new_group :177, update_positions :3092).
export const HORIZONTAL = "horizontal";
export const VERTICAL = "vertical";

export function lengthOf(orientation, size) {
    return orientation === HORIZONTAL ? size.h : size.w;
}

export const GROUP = "group";
export const MAPPED = "mapped";
export const PLACEHOLDER = "placeholder";

export const GRABBED_WINDOW = "grabbed-window";
export const DROP_ZONE = "drop-zone";

export function newGroup(orientation, geo) {
    const half = idiv(lengthOf(orientation, geo), 2);
    return { kind: GROUP, orientation, sizes: [half, half], geo, pill: null };
}

// Upstream's placeholder rect: a group built around a degenerate one sizes to [0, 0] and
// update_geometry then divides by zero (map_to_tree :552, new_group :2903).
export const INITIAL_GEO = { x: 0, y: 0, w: 100, h: 100 };

// Not `{ ...geo }`: KWin's QJSEngine (~ES7) rejects object spread, and the script fails to load.
export function copyGeo(g) { return { x: g.x, y: g.y, w: g.w, h: g.h }; }

// `stacked` is a flag, not windows.length > 1: a stack of one is still a stack upstream.
// `ref` is kept on the active window, the one whose geometry the adapter writes.
export function newMapped(ref, geo) {
    return {
        kind: MAPPED, ref, windows: [ref], active: 0, stacked: false,
        geo: geo || copyGeo(INITIAL_GEO), minimizeRect: null,
    };
}

export function newPlaceholder(id, type, geo) {
    return { kind: PLACEHOLDER, id, type, geo };
}

export function isGroup(d) { return d.kind === GROUP; }
export function isMapped(d) { return d.kind === MAPPED; }
export function isPlaceholder(d) { return d.kind === PLACEHOLDER; }

export function dataLen(d) { return d.kind === GROUP ? d.sizes.length : 1; }

// The new child does not get `equal`; it takes what is left so the vector sums exactly.
export function addWindow(d, idx) {
    if (d.kind !== GROUP) throw new Error("addWindow: not a group");
    const last = lengthOf(d.orientation, d.geo);
    const equal = idiv(last, d.sizes.length + 1);
    const remainder = last - equal;

    for (let i = 0; i < d.sizes.length; i++) {
        d.sizes[i] = roundI32((d.sizes[i] / last) * remainder);
    }
    const used = d.sizes.reduce((a, b) => a + b, 0);
    d.sizes.splice(idx, 0, last - used);
}

export function swapWindows(d, i, j) {
    if (d.kind !== GROUP) throw new Error("swapWindows: not a group");
    const t = d.sizes[i];
    d.sizes[i] = d.sizes[j];
    d.sizes[j] = t;
}

// remove_window :255. `remaining` is summed *after* the removal, and the rounding error is
// pushed entirely onto the last element.
export function removeWindow(d, idx) {
    if (d.kind !== GROUP) throw new Error("removeWindow: not a group");
    const last = lengthOf(d.orientation, d.geo);
    const old = d.sizes.splice(idx, 1)[0];
    const remaining = d.sizes.reduce((a, b) => a + b, 0);

    for (let i = 0; i < d.sizes.length; i++) {
        d.sizes[i] += roundI32((d.sizes[i] / remaining) * old);
    }
    const used = d.sizes.reduce((a, b) => a + b, 0);
    const overflow = last - used;
    if (overflow !== 0 && d.sizes.length > 0) d.sizes[d.sizes.length - 1] += overflow;
}

export function updateGeometry(d, geo) {
    if (d.kind !== GROUP) { d.geo = geo; return; }

    const previous = lengthOf(d.orientation, d.geo);
    const next = lengthOf(d.orientation, geo);
    for (let i = 0; i < d.sizes.length; i++) {
        d.sizes[i] = roundI32((d.sizes[i] / previous) * next);
    }
    const sum = d.sizes.reduce((a, b) => a + b, 0);
    if (sum !== next && d.sizes.length > 0) d.sizes[d.sizes.length - 1] += next - sum;
    d.geo = geo;
}

export function node(data) { return { data, parent: null, children: [] }; }

// Re-parents: move_current_node attaches a node still listed under its old parent, and a node in
// both lists corrupts the tree two layouts later.
export function appendChild(parent, child) {
    if (child.parent) detach(child);
    child.parent = parent;
    parent.children.push(child);
    return child;
}

export function insertChild(parent, child, idx) {
    if (child.parent) detach(child);
    child.parent = parent;
    parent.children.splice(idx, 0, child);
    return child;
}

export function indexIn(parent, child) { return parent.children.indexOf(child); }

export function detach(child) {
    const p = child.parent;
    if (!p) return -1;
    const i = p.children.indexOf(child);
    if (i >= 0) p.children.splice(i, 1);
    child.parent = null;
    return i;
}

export function makeNthSibling(child, idx) {
    const p = child.parent;
    if (!p) return;
    const i = p.children.indexOf(child);
    if (i < 0) return;
    p.children.splice(i, 1);
    p.children.splice(idx, 0, child);
}

export function preOrder(root, out) {
    out = out || [];
    if (!root) return out;
    out.push(root);
    for (const c of root.children) preOrder(c, out);
    return out;
}

// Up/Down need a Horizontal group and Left/Right a Vertical one (see the orientation naming).
export const LEFT = "left", RIGHT = "right", UP = "up", DOWN = "down";

export function hasAdjacentNode(n, dir) {
    let search = n;
    let parent = n.parent;
    while (parent) {
        const idx = parent.children.indexOf(search);
        const o = parent.data.orientation;
        const last = parent.children.length - 1;
        if (dir === UP && o === HORIZONTAL && idx > 0) return true;
        if (dir === DOWN && o === HORIZONTAL && idx < last) return true;
        if (dir === LEFT && o === VERTICAL && idx > 0) return true;
        if (dir === RIGHT && o === VERTICAL && idx < last) return true;
        search = parent;
        parent = parent.parent;
    }
    return false;
}

// Mutates the tree: flattening a one-child group is part of the same walk upstream (:2998).
export function measure(root, area, gaps) {
    if (!root) return { root: null, configures: [] };

    const outer = gaps.outer, inner = gaps.inner;
    let geo = {
        x: area.x + outer,
        y: area.y + outer,
        w: area.w - outer * 2,
        h: area.h - outer * 2,
    };

    const stack = [geo];
    const out = [];
    const order = preOrder(root);
    let newRoot = root;

    for (const n of order) {
        // The child inherits the rect meant for the group, so the stack is not popped.
        if (isGroup(n.data) && dataLen(n.data) === 1 && n.children.length === 1) {
            const child = n.children[0];
            if (n.parent) {
                const idx = indexIn(n.parent, n);
                detach(child);
                const p = n.parent;
                detach(n);
                insertChild(p, child, idx);
            } else {
                detach(child);
                newRoot = child;
            }
            continue;
        }

        if (stack.length === 0) continue;
        let g = stack.pop();

        if (isMapped(n.data)) {
            // Half an inner gap beside a neighbour, a whole one on a free side: a seam is one `inner`,
            // the layout edge `outer + inner`.
            const l = hasAdjacentNode(n, LEFT)  ? idiv(inner, 2) : inner;
            const t = hasAdjacentNode(n, UP)    ? idiv(inner, 2) : inner;
            const r = hasAdjacentNode(n, RIGHT) ? idiv(inner, 2) : inner;
            const b = hasAdjacentNode(n, DOWN)  ? idiv(inner, 2) : inner;
            g = { x: g.x + l, y: g.y + t, w: g.w - l - r, h: g.h - t - b };
        }

        updateGeometry(n.data, g);

        if (isGroup(n.data)) {
            const sizes = n.data.sizes;
            let previous = sizes.reduce((a, b) => a + b, 0);
            for (let i = sizes.length - 1; i >= 0; i--) {
                previous -= sizes[i];
                stack.push(n.data.orientation === HORIZONTAL
                    ? { x: g.x, y: g.y + previous, w: g.w, h: sizes[i] }
                    : { x: g.x + previous, y: g.y, w: sizes[i], h: g.h });
            }
        } else if (isMapped(n.data)) {
            out.push({ node: n, geo: g });
        }
    }

    return { root: newRoot, configures: out };
}

export function newGroupAround(target, incoming, orientation) {
    const g = node(newGroup(orientation, INITIAL_GEO));
    const parent = target.parent;
    const pos = parent ? indexIn(parent, target) : -1;

    if (parent) {
        detach(target);
        insertChild(parent, g, pos);
    }
    appendChild(g, target);
    appendChild(g, incoming);
    return g;
}

export function orientationFor(size) {
    return size.w > size.h ? VERTICAL : HORIZONTAL;
}

// Reads backwards on purpose: a window moved left arrives at the left output's right edge (:570).
export function indexForDirection(dir) {
    return (dir === LEFT || dir === UP) ? 1 : 0;
}

export function orientationForDirection(dir) {
    return (dir === LEFT || dir === RIGHT) ? VERTICAL : HORIZONTAL;
}

export function mapToTree(root, incoming, focused, direction, outputSize) {
    if (!root) return incoming;

    if (direction) {
        const g = newGroupAround(root, incoming, orientationForDirection(direction));
        makeNthSibling(incoming, indexForDirection(direction));
        return g;
    }
    if (focused) {
        const g = newGroupAround(focused, incoming, orientationFor(focused.data.geo));
        return focused === root ? g : root;
    }
    const g = newGroupAround(root, incoming, orientationFor(outputSize));
    return g;
}

// A group of exactly two is dissolved and the survivor inherits its whole rect; larger groups
// redistribute through remove_window (unmap_internal :1446).
export function unmapInternal(root, n) {
    const parent = n.parent;
    if (!parent) return null;

    const pos = indexIn(parent, n);
    const grand = parent.parent;
    const parentPos = grand ? indexIn(grand, parent) : -1;
    detach(n);

    if (dataLen(parent.data) > 2) {
        removeWindow(parent.data, pos);
        return root;
    }

    const survivor = parent.children[0];
    if (!survivor) {
        detach(parent);
        return parent === root ? null : root;
    }
    detach(survivor);
    if (grand) {
        detach(parent);
        insertChild(grand, survivor, parentPos);
        return root;
    }
    survivor.parent = null;
    return survivor;
}

// ResizeEdge stays a bitflag: resize :2514 tests it with `intersects` against the TOP_LEFT pair.
export const EDGE_TOP = 1, EDGE_BOTTOM = 2, EDGE_LEFT = 4, EDGE_RIGHT = 8;
export const EDGE_TOP_LEFT = EDGE_TOP | EDGE_LEFT;

export const INWARDS = "inwards", OUTWARDS = "outwards";

// Hard-coded upstream; a pair summing to under twice the minimum refuses to resize rather than
// fighting over the remainder.
export const MIN_PANE = { [VERTICAL]: 360, [HORIZONTAL]: 240 };
export const MIN_PAIR = { [VERTICAL]: 720, [HORIZONTAL]: 480 };

export function possibleResizes(n) {
    let edges = 0;
    let cur = n;
    while (cur.parent) {
        const parent = cur.parent;
        const idx = indexIn(parent, cur);
        const last = parent.children.length - 1;
        if (parent.data.orientation === VERTICAL) {
            if (idx > 0) edges |= EDGE_LEFT;
            if (idx < last) edges |= EDGE_RIGHT;
        } else {
            if (idx > 0) edges |= EDGE_TOP;
            if (idx < last) edges |= EDGE_BOTTOM;
        }
        cur = parent;
    }
    return edges;
}

export function resizeRequest(n, edge) {
    let cur = n;
    while (cur.parent) {
        const parent = cur.parent;
        const o = parent.data.orientation;
        const idx = indexIn(parent, cur);
        const last = parent.children.length - 1;
        if (o === VERTICAL) {
            if (idx > 0 && (edge & EDGE_LEFT)) return { group: parent, idx: idx - 1, orientation: o };
            if (idx < last && (edge & EDGE_RIGHT)) return { group: parent, idx, orientation: o };
        } else {
            if (idx > 0 && (edge & EDGE_TOP)) return { group: parent, idx: idx - 1, orientation: o };
            if (idx < last && (edge & EDGE_BOTTOM)) return { group: parent, idx, orientation: o };
        }
        cur = parent;
    }
    return null;
}

// Transcribed quirk: `other` tests the edges against TOP|LEFT as a pair, ignoring the orientation
// just matched, so TOP|RIGHT inside a Vertical group picks the neighbour before the node.
export function resize(root, focused, direction, edges, amount) {
    let n = focused;
    while (n.parent) {
        const group = n.parent;
        const o = group.data.orientation;
        const runsAlong =
            (o === VERTICAL && (edges & (EDGE_LEFT | EDGE_RIGHT))) ||
            (o === HORIZONTAL && (edges & (EDGE_TOP | EDGE_BOTTOM)));
        if (!runsAlong) { n = group; continue; }

        const idx = indexIn(group, n);
        let other;
        if (edges & EDGE_TOP_LEFT) {
            if (idx === 0) { n = group; continue; }
            other = idx - 1;
        } else if (group.children.length - 1 > idx) {
            other = idx + 1;
        } else {
            n = group;
            continue;
        }

        const sizes = group.data.sizes;
        const shrinkIdx = direction === INWARDS ? idx : other;
        const growIdx = direction === INWARDS ? other : idx;

        if (sizes[shrinkIdx] + sizes[growIdx] < MIN_PAIR[o]) return { handled: true, changed: false };

        // The shrinking side never grows: clampSizes can leave a neighbour under MIN_PANE (read live:
        // [380, 356] vs 360), and clamping up would move the pair the wrong way by that deficit.
        const old = sizes[shrinkIdx];
        const take = Math.max(0, Math.min(amount, old - MIN_PANE[o]));
        sizes[shrinkIdx] = old - take;
        sizes[growIdx] += take;
        return { handled: true, changed: take !== 0 };
    }
    void root;
    return { handled: true, changed: false };
}

// FURTHER: the layout could not absorb the move, so the caller hands the window to the next
// output or workspace. NONE: nothing to move.
export const MOVE_DONE = "done", MOVE_FURTHER = "further", MOVE_NONE = "none";

function movesAlong(orientation, dir) {
    return orientation === VERTICAL
        ? (dir === LEFT || dir === RIGHT)
        : (dir === UP || dir === DOWN);
}

// You enter from the side you came from: moving left lands at the right end. Opposite of
// indexForDirection, which is about a window arriving from another output.
function entryIndex(dir) { return (dir === LEFT || dir === UP) ? 1 : 0; }

export function moveCurrentNode(root, focused, dir) {
    if (!focused) return { result: MOVE_NONE, root };

    // A stack gets first refusal, before the tree is touched (:1521).
    if (isMapped(focused.data) && isStack(focused.data)) {
        const s = handleStackMove(focused.data, dir);
        if (s.result === STACK_HANDLED) return { result: MOVE_DONE, root };
        if (s.result === STACK_MOVE_OUT) {
            const ejected = node(newMapped(s.ref));
            const wasRoot = focused === root;
            const g = newGroupAround(focused, ejected, orientationForDirection(dir));
            makeNthSibling(ejected, (dir === LEFT || dir === UP) ? 0 : 1);
            return { result: MOVE_DONE, root: wasRoot ? g : root, shiftFocus: ejected };
        }
    }

    const ogParent = focused.parent;
    if (!ogParent) return { result: MOVE_FURTHER, root };
    const ogIdx = indexIn(ogParent, focused);

    let child = focused;
    let parent = ogParent;
    let newRoot = root;

    while (parent) {
        const o = parent.data.orientation;
        const len = dataLen(parent.data);
        const idx = indexIn(parent, child);

        if (!movesAlong(o, dir)) {
            const wasRoot = parent === root;
            const g = newGroupAround(parent, focused, orientationForDirection(dir));
            makeNthSibling(focused, (dir === LEFT || dir === UP) ? 0 : 1);
            removeWindow(ogParent.data, ogIdx);
            if (wasRoot) newRoot = g;
            return { result: MOVE_DONE, root: newRoot };
        }

        // Upstream mismatch, transcribed: moving right puts the node at idx + 1 but inserts its size at
        // idx, so the leftover lands on the neighbour. The vector still sums exactly.
        if (child !== focused) {
            insertChild(parent, focused, (dir === LEFT || dir === UP) ? idx : idx + 1);
            addWindow(parent.data, idx);
            removeWindow(ogParent.data, ogIdx);
            return { result: MOVE_DONE, root: newRoot };
        }

        let nextIdx = null;
        if ((o === HORIZONTAL && dir === DOWN) || (o === VERTICAL && dir === RIGHT)) {
            if (idx < len - 1) nextIdx = idx + 1;
        } else if ((o === HORIZONTAL && dir === UP) || (o === VERTICAL && dir === LEFT)) {
            if (idx > 0) nextIdx = idx - 1;
        }

        if (nextIdx !== null) {
            const next = parent.children[nextIdx];

            // Only from a group of two: with more siblings upstream gives the window a place of its own.
            if (isMapped(next.data) && isStack(next.data) &&
                isMapped(focused.data) && !isStack(focused.data) && len === 2) {
                detach(focused);
                stackAdd(next.data, focused.data.windows, dir === RIGHT ? 0 : null);
                removeWindow(ogParent.data, ogIdx);
                return { result: MOVE_DONE, root: newRoot, shiftFocus: next };
            }

            if (isGroup(next.data) && len === 2) {
                const go = next.data.orientation;
                const groupLen = dataLen(next.data);
                appendChild(next, focused);

                if ((go === HORIZONTAL && dir === DOWN) || (go === VERTICAL && dir === RIGHT)) {
                    makeNthSibling(focused, 0);
                    addWindow(next.data, 0);
                } else if ((go === HORIZONTAL && dir === UP) || (go === VERTICAL && dir === LEFT)) {
                    makeNthSibling(focused, next.children.length - 1);
                    addWindow(next.data, groupLen);
                } else if (groupLen % 2 === 0) {
                    makeNthSibling(focused, groupLen / 2);
                    addWindow(next.data, groupLen / 2);
                } else {
                    const old = next.children[idiv(groupLen, 2)];
                    newGroupAround(old, focused, go === HORIZONTAL ? VERTICAL : HORIZONTAL);
                    makeNthSibling(focused, entryIndex(dir));
                }
                removeWindow(ogParent.data, ogIdx);
                return { result: MOVE_DONE, root: newRoot };
            }

            if (len === 2) {
                makeNthSibling(focused, nextIdx);
                swapWindows(parent.data, idx, nextIdx);
                return { result: MOVE_DONE, root: newRoot };
            }

            newGroupAround(next, focused, o);
            makeNthSibling(focused, entryIndex(dir));
            removeWindow(ogParent.data, ogIdx);
            return { result: MOVE_DONE, root: newRoot };
        }

        child = parent;
        parent = parent.parent;
    }

    return { result: MOVE_FURTHER, root: newRoot };
}

// Resolved on the live layout, not upstream's geometries_for_groupview (the COSMIC overview,
// which KOSMIC does not have).

export const ANIMATION_DURATION = 200;
export const MINIMIZE_ANIMATION_DURATION = 320;
export const MOUSE_ANIMATION_DELAY = 150;
export const INITIAL_MOUSE_ANIMATION_DELAY = 500;

// 32px to enter an edge band, 80px to leave: the hysteresis stops flicker on the boundary.
export const EDGE_BAND = 32;
export const EDGE_BAND_HELD = 80;

export const ZONE_INITIAL = "initial";
export const ZONE_INITIAL_PLACEHOLDER = "initial-placeholder";
export const ZONE_WINDOW_STACK = "window-stack";
export const ZONE_WINDOW_SPLIT = "window-split";
export const ZONE_GROUP_EDGE = "group-edge";
export const ZONE_GROUP_INTERIOR = "group-interior";

export function zonesEqual(a, b) {
    if (!a || !b) return a === b;
    return a.kind === b.kind && a.node === b.node &&
        a.dir === b.dir && a.idx === b.idx;
}

function contains(r, p) {
    return p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
}

function hasDropZoneChild(n) {
    return n.children.some((c) => isPlaceholder(c.data) && c.data.type === DROP_ZONE);
}

// Stops at a group already holding a drop zone, as upstream: aiming at a window moves it, so a
// live layout would otherwise chase the pointer.
export function nodeUnder(root, p) {
    let result = null;
    let lookup = root;
    while (lookup) {
        if (contains(lookup.data.geo, p)) result = lookup;
        const current = lookup;
        lookup = null;
        if (result && isGroup(current.data)) {
            if (hasDropZoneChild(current)) break;
            for (const child of current.children) {
                if (contains(child.data.geo, p)) { lookup = child; break; }
            }
        }
    }
    return result;
}

// Carved left, top, right, bottom, so the bands are not symmetric: the top spans the width left
// narrowed, and a corner belongs to the band carved first.
function edgeBands(geo, held) {
    const g = { x: geo.x, y: geo.y, w: geo.w, h: geo.h };
    const band = (d) => (held === d ? EDGE_BAND_HELD : EDGE_BAND);

    const l = band(LEFT);
    const left = { x: g.x, y: g.y, w: l, h: g.h };
    g.x += l; g.w -= l;

    const t = band(UP);
    const top = { x: g.x, y: g.y, w: g.w, h: t };
    g.y += t; g.h -= t;

    const r = band(RIGHT);
    const right = { x: g.x + g.w - r, y: g.y, w: r, h: g.h };
    g.w -= r;

    const b = band(DOWN);
    const bottom = { x: g.x, y: g.y + g.h - b, w: g.w, h: b };
    g.h -= b;

    return { left, top, right, bottom, rest: g };
}

function interiorIndex(group, p) {
    const o = group.data.orientation;
    let found = -1;
    for (let i = 0; i < group.children.length; i++) {
        const geo = group.children[i].data.geo;
        if (o === VERTICAL ? p.x < geo.x : p.y < geo.y) { found = i; break; }
    }
    if (found <= 0) return 0;
    return found - 1;
}

// Middle third in both axes is a stack; the split side is the nearest edge as a fraction, not px.
function windowZone(id, geo, p) {
    const thirdW = roundI32(geo.w / 3);
    const thirdH = roundI32(geo.h / 3);
    const stack = {
        x: geo.x + thirdW,
        y: geo.y + thirdH,
        w: thirdW,
        h: thirdH,
    };
    if (contains(stack, p)) return { kind: ZONE_WINDOW_STACK, node: id, geo };

    const relX = p.x - geo.x;
    const leftRight = relX < geo.w / 2
        ? { dir: LEFT, frac: relX / geo.w }
        : { dir: RIGHT, frac: 1 - relX / geo.w };
    const relY = p.y - geo.y;
    const upDown = relY < geo.h / 2
        ? { dir: UP, frac: relY / geo.h }
        : { dir: DOWN, frac: 1 - relY / geo.h };

    const dir = leftRight.frac < upDown.frac ? leftRight.dir : upDown.dir;
    return { kind: ZONE_WINDOW_SPLIT, node: id, dir };
}

// Divergence from upstream: group edge bands are tested before descending. Upstream's overview
// pads groups; on the live layout children fill them, so GroupEdge/GroupInterior would be unreachable.
export function zoneAt(root, p, held) {
    if (!root) return { kind: ZONE_INITIAL };
    if (!contains(root.data.geo, p)) return { kind: ZONE_INITIAL };

    let n = root;
    for (;;) {
        if (isPlaceholder(n.data)) return { kind: ZONE_INITIAL_PLACEHOLDER, node: n };

        if (isGroup(n.data)) {
            if (hasDropZoneChild(n)) break;

            const heldEdge = (held && held.kind === ZONE_GROUP_EDGE && held.node === n)
                ? held.dir : null;
            const bands = edgeBands(n.data.geo, heldEdge);
            // Tested left, right, top, bottom, not in carving order: a corner carved into the top loses to Right.
            if (contains(bands.left, p))   return { kind: ZONE_GROUP_EDGE, node: n, dir: LEFT };
            if (contains(bands.right, p))  return { kind: ZONE_GROUP_EDGE, node: n, dir: RIGHT };
            if (contains(bands.top, p))    return { kind: ZONE_GROUP_EDGE, node: n, dir: UP };
            if (contains(bands.bottom, p)) return { kind: ZONE_GROUP_EDGE, node: n, dir: DOWN };

            const child = n.children.find((c) => contains(c.data.geo, p));
            if (!child) return { kind: ZONE_GROUP_INTERIOR, node: n, idx: interiorIndex(n, p) };
            n = child;
            continue;
        }

        break;
    }

    const target = isGroup(n.data)
        ? n.children.find((c) => isMapped(c.data)) || n
        : n;
    return windowZone(target, n.data.geo, p);
}

// Leaving the dragged window's own placeholder is slower, so a twitch at drag start does not
// tear the layout apart.
export function dwellElapsed(heldZone, since, now) {
    const delay = heldZone && heldZone.kind === ZONE_INITIAL_PLACEHOLDER
        ? INITIAL_MOUSE_ANIMATION_DELAY
        : MOUSE_ANIMATION_DELAY;
    return (now - since) > delay;
}

export function dropWindow(root, incoming, zone, outputSize) {
    if (!zone) return { root: mapToTree(root, incoming, null, null, outputSize), target: incoming };

    switch (zone.kind) {
        case ZONE_GROUP_EDGE: {
            const group = zone.node;
            const o = orientationForDirection(zone.dir);
            const first = (zone.dir === LEFT || zone.dir === UP);

            if (group.data.orientation !== o) {
                const wasRoot = group === root;
                const g = newGroupAround(group, incoming, o);
                makeNthSibling(incoming, first ? 0 : 1);
                return { root: wasRoot ? g : root, target: incoming };
            }
            const len = dataLen(group.data);
            addWindow(group.data, first ? 0 : len);
            insertChild(group, incoming, first ? 0 : group.children.length);
            return { root, target: incoming };
        }

        case ZONE_GROUP_INTERIOR: {
            const group = zone.node;
            // Clamped: the index was computed against a layout that may have changed during the dwell.
            const idx = Math.min(dataLen(group.data), zone.idx + 1);
            addWindow(group.data, idx);
            insertChild(group, incoming, idx);
            return { root, target: incoming };
        }

        case ZONE_INITIAL_PLACEHOLDER: {
            const ph = zone.node;
            const geo = ph.data.geo;
            ph.data = incoming.data;
            ph.data.geo = geo;
            return { root, target: ph };
        }

        case ZONE_WINDOW_SPLIT: {
            const target = zone.node;
            const o = orientationForDirection(zone.dir);
            const wasRoot = target === root;
            const g = newGroupAround(target, incoming, o);
            if (zone.dir === LEFT || zone.dir === UP) makeNthSibling(incoming, 0);
            return { root: wasRoot ? g : root, target: incoming };
        }

        case ZONE_WINDOW_STACK: {
            const target = zone.node;
            if (!isMapped(target.data)) break;
            convertToStack(target.data);
            stackAdd(target.data, incoming.data.windows, null);
            return { root, target };
        }

        default:
            break;
    }
    return { root: mapToTree(root, incoming, null, null, outputSize), target: incoming };
}

// Only the inner gap applies: `inner` on an outside edge, `inner / 2` either side of the midline,
// so a snapped seam equals a tiled one.
export const TILED_TOP = "top", TILED_BOTTOM = "bottom";
export const TILED_LEFT = "left", TILED_RIGHT = "right";
export const TILED_TOP_LEFT = "top-left", TILED_TOP_RIGHT = "top-right";
export const TILED_BOTTOM_LEFT = "bottom-left", TILED_BOTTOM_RIGHT = "bottom-right";

export function cornerGeometry(corner, work, gaps) {
    const g = gaps.inner;
    const halfW = idiv(work.w, 2), halfH = idiv(work.h, 2);
    const near = g, mid = idiv(g, 2);
    const shrinkHalf = idiv(g * 3, 2);

    const left = work.x + near;
    const right = work.x + halfW + mid;
    const top = work.y + near;
    const bottom = work.y + halfH + mid;
    const fullW = work.w - near * 2;
    const fullH = work.h - near * 2;
    const halfWidth = halfW - shrinkHalf;
    const halfHeight = halfH - shrinkHalf;

    switch (corner) {
        case TILED_TOP:          return { x: left,  y: top,    w: fullW,     h: halfHeight };
        case TILED_BOTTOM:       return { x: left,  y: bottom, w: fullW,     h: halfHeight };
        case TILED_LEFT:         return { x: left,  y: top,    w: halfWidth, h: fullH };
        case TILED_RIGHT:        return { x: right, y: top,    w: halfWidth, h: fullH };
        case TILED_TOP_LEFT:     return { x: left,  y: top,    w: halfWidth, h: halfHeight };
        case TILED_TOP_RIGHT:    return { x: right, y: top,    w: halfWidth, h: halfHeight };
        case TILED_BOTTOM_LEFT:  return { x: left,  y: bottom, w: halfWidth, h: halfHeight };
        case TILED_BOTTOM_RIGHT: return { x: right, y: bottom, w: halfWidth, h: halfHeight };
        default: return null;
    }
}

// A zero in min or max means "unset" upstream and is ignored.
export function floatingSize(want, work, minSize, maxSize) {
    const min = minSize || { w: 320, h: 240 };
    const twoThirdsW = idiv(work.w, 3) * 2;
    const twoThirdsH = idiv(work.h, 3) * 2;
    const max = maxSize || { w: Math.max(min.w, twoThirdsW), h: Math.max(min.h, twoThirdsH) };

    let w = want.w, h = want.h;
    if (w > max.w) {
        let width = twoThirdsW;
        if (max.w !== 0) width = Math.min(max.w, width);
        if (min.w !== 0) width = Math.max(min.w, width);
        w = width;
    }
    w = Math.min(w, work.w);

    if (h > max.h) {
        let height = twoThirdsH;
        if (max.h !== 0) height = Math.min(max.h, height);
        if (min.h !== 0) height = Math.max(min.h, height);
        h = height;
    }
    h = Math.min(h, work.h);

    return { w, h };
}

export function newWorkspace(tiled) {
    return { tiling: null, floating: [], tilingEnabled: tiled !== false, lastFloating: new Map() };
}

export function findMapped(root, ref) {
    if (!root) return null;
    for (const n of preOrder(root)) {
        if (isMapped(n.data) && n.data.ref === ref) return n;
    }
    return null;
}

export function floatingIndex(ws, ref) {
    return ws.floating.findIndex((f) => f.ref === ref);
}

export function mapFloating(ws, ref, geo) {
    const remembered = ws.lastFloating.get(ref);
    ws.floating.push({ ref, geo: geo || remembered || copyGeo(INITIAL_GEO) });
}

export function unmapFloating(ws, ref) {
    const i = floatingIndex(ws, ref);
    if (i < 0) return null;
    const [entry] = ws.floating.splice(i, 1);
    ws.lastFloating.set(ref, entry.geo);
    return entry.geo;
}

// No-op on a workspace that does not tile: when everything floats there is nothing to toggle.
export function toggleFloatingWindow(ws, ref, outputSize, focusedRef) {
    if (!ws.tilingEnabled) return false;

    const n = findMapped(ws.tiling, ref);
    if (n) {
        const geo = copyGeo(n.data.geo);
        ws.tiling = unmapInternal(ws.tiling, n);
        mapFloating(ws, ref, ws.lastFloating.get(ref) || geo);
        return true;
    }
    if (floatingIndex(ws, ref) >= 0) {
        unmapFloating(ws, ref);
        const focused = focusedRef ? findMapped(ws.tiling, focusedRef) : null;
        ws.tiling = mapToTree(ws.tiling, node(newMapped(ref)), focused, null, outputSize);
        return true;
    }
    return false;
}

export function setTilingEnabled(ws, on, outputSize) {
    if (on === ws.tilingEnabled) return;

    if (on) {
        const refs = ws.floating.map((f) => f.ref);
        for (const ref of refs) {
            unmapFloating(ws, ref);
            ws.tiling = mapToTree(ws.tiling, node(newMapped(ref)), null, null, outputSize);
        }
    } else {
        const nodes = preOrder(ws.tiling).filter((n) => isMapped(n.data));
        for (const n of nodes) {
            const geo = copyGeo(n.data.geo);
            const ref = n.data.ref;
            ws.tiling = unmapInternal(ws.tiling, n);
            mapFloating(ws, ref, ws.lastFloating.get(ref) || geo);
        }
    }
    ws.tilingEnabled = on;
}

export function isStack(d) { return d.kind === MAPPED && d.stacked; }

// Every mutation goes through this: a stale `ref` writes geometry to the wrong window, which
// looks like a layout bug.
function syncActive(d) {
    if (d.active < 0) d.active = 0;
    if (d.active > d.windows.length - 1) d.active = Math.max(0, d.windows.length - 1);
    d.ref = d.windows[d.active];
}

export function convertToStack(d) {
    d.stacked = true;
    syncActive(d);
}

export function stackAdd(d, refs, idx) {
    const list = Array.isArray(refs) ? refs : [refs];
    if (idx === null || idx === undefined) d.windows.push(...list);
    else d.windows.splice(idx, 0, ...list);
    syncActive(d);
}

export function stackSetActive(d, idx) {
    d.active = idx;
    syncActive(d);
}

// Clamped, not wrapped: running off the end ejects a window (handle_move), so wrapping would hide that.
export function stackCycle(d, step) {
    const next = d.active + step;
    if (next < 0 || next >= d.windows.length) return false;
    d.active = next;
    syncActive(d);
    return true;
}

export const STACK_HANDLED = "handled", STACK_MOVE_OUT = "move-out", STACK_DEFAULT = "default";

// Left/Right reorder within the stack; Up/Down and running off either end eject. A stack of one
// declines, so it travels like a plain window.
export function handleStackMove(d, dir) {
    if (!isStack(d)) return { result: STACK_DEFAULT };

    let next = null;
    if (dir === LEFT && d.active > 0) next = d.active - 1;
    else if (dir === RIGHT && d.active + 1 < d.windows.length) next = d.active + 1;

    if (next !== null) {
        const old = d.active;
        const t = d.windows[old];
        d.windows[old] = d.windows[next];
        d.windows[next] = t;
        d.active = next;
        syncActive(d);
        return { result: STACK_HANDLED };
    }

    if (d.windows.length === 1) return { result: STACK_DEFAULT };

    const ref = d.windows.splice(d.active, 1)[0];
    // Upstream steps back only when the last window was removed; otherwise the index now names the next.
    if (d.active === d.windows.length) d.active = d.active - 1;
    syncActive(d);
    return { result: STACK_MOVE_OUT, ref };
}

export function toggleStacking(root, n, outputSize) {
    const d = n.data;
    if (!isMapped(d)) return { root, target: n };

    if (!isStack(d)) {
        convertToStack(d);
        return { root, target: n };
    }

    const rest = d.windows.slice(1);
    const first = d.windows[0];
    d.windows = [first];
    d.active = 0;
    d.stacked = false;
    syncActive(d);

    let newRoot = root;
    let current = n;
    for (const ref of rest) {
        const leaf = node(newMapped(ref));
        newRoot = mapToTree(newRoot, leaf, current, null, outputSize);
        current = leaf;
    }
    return { root: newRoot, target: n };
}

// A fixed size (min == max) gives a window away as untileable whatever it calls itself (is_dialog :20).
export function isDialog(desc) {
    if (!desc) return false;
    if (desc.transient || desc.modal || desc.dialog || desc.override) return true;

    const mn = desc.minSize, mx = desc.maxSize;
    if (mn && mx && (mn.w > 0 || mn.h > 0) && mn.w === mx.w && mn.h === mx.h) return true;
    return false;
}

// Upstream drops the whole rule when either regex fails to compile; `onBad` reports it so the
// rule does not silently do nothing.
export function compileExceptions(rules, onBad) {
    const out = [];
    for (const rule of rules || []) {
        const appid = rule.appid === undefined ? "" : String(rule.appid);
        const titles = Array.isArray(rule.titles)
            ? rule.titles
            : [rule.title === undefined ? "" : rule.title];

        for (const raw of titles) {
            const title = raw === undefined || raw === null ? "" : String(raw);
            let a, t;
            try {
                a = new RegExp(appid);
                t = new RegExp(title);
            } catch (e) {
                if (onBad) onBad({ appid, title }, String(e));
                continue;
            }
            out.push({ appid: a, title: t });
        }
    }
    return out;
}

export const DEFAULT_EXCEPTIONS = [
    { appid: ".*", titles: ["Discord Updater"] },
    { appid: "", titles: ["Steam", "wl-clipboard"] },
    { appid: "Authy Desktop", titles: [".*"] },
    { appid: "Com.github.amezin.ddterm", titles: [".*"] },
    { appid: "Com.github.donadigo.eddy", titles: [".*"] },
    { appid: "com.system76.CosmicFilesDialog", titles: [".*"] },
    { appid: "com.system76.CosmicStoreDialog", titles: [".*"] },
    { appid: "Enpass", titles: ["Enpass Assistant"] },
    { appid: "Gjs", titles: ["Settings"] },
    { appid: "Gnome-initial-setup", titles: [".*"] },
    { appid: "Gnome-terminal", titles: ["Preferences - General"] },
    { appid: "Guake", titles: [".*"] },
    { appid: "Io.elementary.sideload", titles: [".*"] },
    { appid: "KotatogramDesktop", titles: ["Media viewer"] },
    { appid: "Mozilla VPN", titles: [".*"] },
    { appid: "update-manager", titles: ["Software Updater"] },
    { appid: "Solaar", titles: [".*"] },
    { appid: "Steam", titles: ["^.*?(Guard|Login).*"] },
    { appid: "TelegramDesktop", titles: ["Media viewer"] },
    { appid: "Zotero", titles: ["Quick Format Citation"] },
    { appid: "gjs", titles: [".*"] },
    { appid: "gnome-screenshot", titles: [".*"] },
    { appid: "ibus-.*", titles: [".*"] },
    { appid: "jetbrains-toolbox", titles: [".*"] },
    { appid: "jetbrains-webstorm", titles: ["Customize WebStorm", "License Activation", "Welcome to WebStorm"] },
    { appid: "krunner", titles: [".*"] },
    { appid: "pritunl", titles: [".*"] },
    { appid: "re.sonny.Junction", titles: [".*"] },
    { appid: "system76-driver", titles: [".*"] },
    { appid: "tilda", titles: [".*"] },
    { appid: "zoom", titles: [".*"] },
    { appid: "Tor Browser", titles: [".*"] },
    { appid: "^.*?action=join.*$", titles: [".*"] },
    { appid: "^(slack|com.slack.Slack)", titles: ["^.*?(Huddle Preview).*"] },
    { appid: "^(thunderbird|org.mozilla.thunderbird)(-esr|_esr)*", titles: ["^(Write:).*"] },

    // Not from COSMIC: Plasma's own surfaces arrive as ordinary toplevels on KWin and would be tiled.
    { appid: "^(plasmashell|org\\.kde\\.plasmashell)$", titles: [".*"] },
    { appid: "^ksplashqml$", titles: [".*"] },
    { appid: "^kded[0-9]*$", titles: [".*"] },
    { appid: "^xwaylandvideobridge$", titles: [".*"] },
    { appid: "^(org\\.kde\\.)?polkit-kde-authentication-agent-1$", titles: [".*"] },
    { appid: "^(org\\.kde\\.)?kruler$", titles: [".*"] },
    { appid: "^kwin_wayland$", titles: [".*"] },
    { appid: "^ksmserver-logout-greeter$", titles: [".*"] },
    { appid: "^(org\\.kde\\.)?yakuake$", titles: [".*"] },
    { appid: "^conky$", titles: [".*"] },
    // Spectacle's window exists during a capture but is not on screen, so tiling it reserves a slot of
    // wallpaper that no check here can see.
    { appid: "^(org\\.kde\\.)?spectacle$", titles: [".*"] },
];

// AND within a rule, OR across rules: the same index must match in both RegexSets. An empty pattern
// matches everything, so a rule with both fields empty floats every window, as upstream.
export function hasFloatingException(exceptions, appId, title) {
    const id = appId === undefined || appId === null ? "" : String(appId);
    const t = title === undefined || title === null ? "" : String(title);
    for (const rule of exceptions || []) {
        if (rule.appid.test(id) && rule.title.test(t)) return true;
    }
    return false;
}
