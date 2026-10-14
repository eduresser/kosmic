// SPDX-FileCopyrightText: 2024 System76, Inc. <info@system76.com>

// KOSMIC's pure core: the N-ary group tree of cosmic-comp, with no reference to the KWin
// API. Everything here takes numbers and returns numbers, so the simulator exercises these
// functions directly rather than fake windows, and a reimplementation elsewhere only has to
// port this file.
//
// References are pop-os/cosmic-comp, src/shell/layout/tiling/mod.rs.
// Line numbers drift; the symbol names do not.

// ---------- Rust arithmetic ----------
//
// The original is i32 and f64, and the two casts it leans on are not JavaScript's. Getting
// these wrong does not throw, it drifts a pixel at a time until a row stops summing to its
// group, so they are spelled out rather than inlined.

// Rust's `i32 / i32` truncates toward zero. JavaScript's `/` does not divide integers at all.
export function idiv(a, b) { return Math.trunc(a / b); }

// Rust's `f64::round() as i32`. `round` breaks ties away from zero, where `Math.round` breaks
// them toward +Infinity, so the two disagree on every negative half. `as i32` saturates and
// turns NaN into 0 — which is load-bearing: remove_window divides by a remainder that is zero
// when every surviving size is zero, and the original relies on the resulting NaN becoming a
// no-op that the overflow correction then cleans up.
export function roundI32(x) {
    if (Number.isNaN(x)) return 0;
    if (x === Infinity) return 2147483647;
    if (x === -Infinity) return -2147483648;
    const r = x < 0 ? -Math.round(-x) : Math.round(x);
    if (r > 2147483647) return 2147483647;
    if (r < -2147483648) return -2147483648;
    return r;
}

// ---------- Orientation ----------
//
// cosmic-comp names the dividing line, not the direction the children run. A Horizontal group
// is divided by a horizontal line: it splits its *height* and stacks its children top to
// bottom. new_group :177 and update_positions :3092 are the two places that fix this, and both
// agree. The binary fork tree this replaces used the opposite convention.
export const HORIZONTAL = "horizontal";   // splits height; children run top to bottom
export const VERTICAL = "vertical";       // splits width;  children run left to right

// Length of a rect along the axis a group of this orientation divides.
export function lengthOf(orientation, size) {
    return orientation === HORIZONTAL ? size.h : size.w;
}

// ---------- Data ----------
//
// enum Data :150. A group carries one size per child along its orientation; a leaf carries
// only where it last was. `alive` is a refcount for COSMIC's focus stack and has no meaning
// here, so it is left out rather than faked.

export const GROUP = "group";
export const MAPPED = "mapped";
export const PLACEHOLDER = "placeholder";

// enum PlaceholderType :171
export const GRABBED_WINDOW = "grabbed-window";
export const DROP_ZONE = "drop-zone";

// new_group :177 — two children, each half the length.
export function newGroup(orientation, geo) {
    const half = idiv(lengthOf(orientation, geo), 2);
    return { kind: GROUP, orientation, sizes: [half, half], geo, pill: null };
}

// Every node upstream is born with this rather than with a real rectangle — map_to_tree :552 and
// new_group :2903 both use it. It matters: a group's sizes come from its geometry at
// construction, so building one around a degenerate rect gives [0, 0], and update_geometry then
// divides by that zero. The NaN casts to 0, the overflow correction hands the whole length to
// the last child, and the first child measures to nothing. A fixed placeholder has no such
// trouble — the first measure rescales [50, 50] into a real even split.
export const INITIAL_GEO = { x: 0, y: 0, w: 100, h: 100 };

// Every copy of a geometry goes through this, and not through `{ ...geo }`.
//
// A KWin script runs in QJSEngine, Qt's V4, which is roughly ES7: object spread in a literal is a
// syntax error there and perfectly ordinary JavaScript everywhere else. Node accepts it, so the
// simulators accept it, and the first thing that notices is the session failing to load the script
// at all. tests/qml/load.qml exists to catch the next one.
export function copyGeo(g) { return { x: g.x, y: g.y, w: g.w, h: g.h }; }

// A window. `ref` is whatever the adapter uses to name one; the core never looks inside it.
//
// A stack is a *kind of leaf*, not a node and not a side table hung off one. Upstream a stack is
// CosmicStack, which is a kind of window: the tree never sees the difference, and toggling a
// window into a stack leaves the node exactly where it was. So every leaf carries a window list
// and an active index, and `ref` is kept pointing at the active one — that is the window whose
// geometry the adapter writes.
//
// `stacked` is a flag rather than `windows.length > 1`, because a stack of one is still a stack
// upstream: converting a lone window gives you a stack you can drop others onto.
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

// len :328 — a group is as long as its size vector, everything else counts as one.
export function dataLen(d) { return d.kind === GROUP ? d.sizes.length : 1; }

// add_window :219. The new child does *not* get `equal`: that value only exists to derive the
// remainder the survivors are scaled into. The new child takes whatever is left over, which is
// what keeps the vector summing to the group's length exactly.
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

// swap_windows :246
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

// update_geometry :292 — rescale the sizes into the new length, then put the rounding error on
// the last element so the vector still sums exactly.
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

// ---------- Tree ----------
//
// cosmic-comp uses an arena with NodeIds because Rust will not hand out two mutable borrows
// into one tree. That constraint does not exist here, so a node holds its children directly
// and points back at its parent. Everything below is structure only — no geometry.

export function node(data) { return { data, parent: null, children: [] }; }

// Both of these re-parent rather than merely link. move_current_node builds a group around a
// node's own parent and then moves the node in beside it, so the incoming node is still in the
// old parent's child list at that moment. Leaving it in both lists corrupts the tree in a way
// that only shows up two layouts later, so the detach is here and not at every call site.
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

// make_nth_sibling: move an already-attached node to a given index under its parent.
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

// has_adjacent_node — walk up the ancestors; the node has a neighbour in `dir` as soon as some
// ancestor is a group whose orientation runs along `dir` and whose child on that side exists.
// Direction is a side of the node, so Up/Down need a Horizontal group and Left/Right a
// Vertical one — the orientation naming above is what makes that read backwards at a glance.
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

// ---------- measure ----------
//
// update_positions :2998. Walks the tree once, carrying a stack of rects: a group pops the rect
// it was given and pushes one per child, in reverse, so the pre-order walk pops them in order.
//
// Returns the list of mapped nodes with the geometry they should be given. It does not write
// anything — that is the adapter's job — but it *does* mutate the tree, because flattening a
// one-child group is part of the same walk upstream.
//
// `area` is the work area; `gaps` is { outer, inner }.
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
        // Flatten a group that is down to one child, lifting the child into the group's own
        // place rather than onto the end. Note this does not pop the stack: the rect that was
        // meant for the group is what the child inherits.
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
            // Half an inner gap on a side that has a neighbour, a whole one on a side that does
            // not. Two neighbours therefore contribute half each and the gap between them is
            // one `inner`, while the outside of the layout gets `outer + inner`.
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
        // A placeholder takes its geometry and asks for nothing.
    }

    return { root: newRoot, configures: out };
}

// ---------- insertion ----------
//
// new_group :2898 at the tree level: put a fresh group where `target` sits and give it
// [target, incoming], in that order. The incoming window is therefore always the second child
// unless someone moves it afterwards.
//
// The original reaches this through two id_tree calls — insert AsRoot, then move_node into the
// group — whose interaction with an existing root is an artifact of that arena library and has
// no counterpart here. The outcome is what is ported: a group in the target's place, holding
// the target and then the newcomer.
export function newGroupAround(target, incoming, orientation) {
    // INITIAL_GEO, not the target's rectangle. Upstream does the same, and the reason is in the
    // comment on that constant: a group built around a degenerate rect measures one child to
    // nothing. The first measure rescales the even split into the real geometry anyway.
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

// A group splits along its longer side, so a wide thing is divided by a vertical line and a
// tall one by a horizontal line. map_to_tree :548 asks this of the focused window's rect, and
// of the output's when there is no focus.
export function orientationFor(size) {
    return size.w > size.h ? VERTICAL : HORIZONTAL;
}

// Direction a window travelled to get here, for a map that came from another output or
// workspace. It reads backwards on purpose: a window moved to the *left* arrives at the left
// output's *right* edge, so Left and Up land it after the existing content and Right and Down
// before it (map_to_tree :570).
export function indexForDirection(dir) {
    return (dir === LEFT || dir === UP) ? 1 : 0;
}

export function orientationForDirection(dir) {
    return (dir === LEFT || dir === RIGHT) ? VERTICAL : HORIZONTAL;
}

// map_to_tree :548. `focused` is the node to split, or null; `direction` is set only when the
// window arrived from elsewhere. Returns the root, which changes whenever the tree was empty or
// the whole thing got wrapped.
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

// ---------- removal ----------
//
// unmap_internal :1446. Two cases, and the split between them is the part worth keeping: a
// group of more than two redistributes through remove_window, but a group of exactly two is
// dissolved instead, and the survivor inherits the group's whole rectangle rather than a
// rescaled share of it. The size vector is dropped on that path, not fixed up.
//
// Returns the root, which changes when the node removed was the root or when dissolving a
// group lifted its survivor there.
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
        // A group that held nothing but the removed node. Nothing upstream produces this, but
        // dropping the empty group is the only sane answer if something ever does.
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

// ---------- resize ----------
//
// ResizeEdge is a bitflag upstream and stays one here, because resize :2514 tests it with
// `intersects` against the TOP_LEFT pair rather than matching a single edge.
export const EDGE_TOP = 1, EDGE_BOTTOM = 2, EDGE_LEFT = 4, EDGE_RIGHT = 8;
export const EDGE_TOP_LEFT = EDGE_TOP | EDGE_LEFT;

export const INWARDS = "inwards", OUTWARDS = "outwards";

// The minimums are hard-coded upstream, in logical pixels, and are the reason a resize can
// silently do nothing. A pane never shrinks past these, and a *pair* whose sizes already sum to
// less than twice one refuses to resize at all rather than fighting over the remainder.
export const MIN_PANE = { [VERTICAL]: 360, [HORIZONTAL]: 240 };
export const MIN_PAIR = { [VERTICAL]: 720, [HORIZONTAL]: 480 };

// possible_resizes :2443 — which edges of this node can be dragged at all. An edge is available
// when some ancestor group runs along it and the node is not the outermost child on that side.
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

// resize_request :2477 — the seam an interactive drag on `edge` actually moves, as the group it
// belongs to and the index of the size *before* the seam. Walks up until it finds one.
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

// resize :2514. Walks up from the focused node for a group that runs along the requested edges,
// moves `amount` between that node's size and its neighbour's, and stops at the minimums.
//
// Returns true when the gesture was understood — which upstream includes the cases where nothing
// moved, so a refusal on the minimums is not reported as a failure to the caller. `changed` is
// the part that says whether the tree actually needs re-measuring.
//
// One transcribed quirk: `other` is chosen by testing the edges against TOP|LEFT as a pair,
// without consulting the orientation that was just matched. Asking to resize TOP|RIGHT inside a
// Vertical group therefore picks the neighbour *before* the node, because TOP is set. The
// orientation filter above it is what normally keeps that combination from arising.
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

        // The shrinking side never grows. Upstream writes this as max(old - amount, MIN_PANE) and
        // cannot reach the case where that matters: cosmic-comp's tiling has no minimum machinery,
        // so no pane is ever under the figure to begin with. KOSMIC's is, because clampSizes has
        // to reserve a stubborn client's minimum and redistributes the vector to do it -- which
        // leaves a neighbour below MIN_PANE often enough to be ordinary. One such group, read out
        // of a live session: [380, 356] against a minimum of 360.
        //
        // Clamping *up* there returns a negative difference, so the pair moves the wrong way by
        // exactly how far under it already was -- once -- and then goes dead. The arrow does the
        // opposite of what it says and then stops saying anything. Refusing is the only reading of
        // "a pane never shrinks past the minimum" that still holds when it is already past it.
        const old = sizes[shrinkIdx];
        const take = Math.max(0, Math.min(amount, old - MIN_PANE[o]));
        sizes[shrinkIdx] = old - take;
        sizes[growIdx] += take;
        return { handled: true, changed: take !== 0 };
    }
    void root;
    return { handled: true, changed: false };
}

// ---------- keyboard movement ----------
//
// move_current_node :1507. Results mirror MoveResult upstream: DONE when the layout absorbed
// the move, FURTHER when it could not and the caller should hand the window to the next output
// or workspace, NONE when there was nothing to move.
export const MOVE_DONE = "done", MOVE_FURTHER = "further", MOVE_NONE = "none";

function movesAlong(orientation, dir) {
    return orientation === VERTICAL
        ? (dir === LEFT || dir === RIGHT)
        : (dir === UP || dir === DOWN);
}

// Where a window lands when it moves into a cell: you enter from the side you came from, so
// moving left puts you at the *right* end of what you moved into. This is the opposite of
// indexForDirection, which answers a different question — that one is about a window arriving
// from another output, this one is about a deliberate move within one layout.
function entryIndex(dir) { return (dir === LEFT || dir === UP) ? 1 : 0; }

export function moveCurrentNode(root, focused, dir) {
    if (!focused) return { result: MOVE_NONE, root };

    // A stack gets first refusal: it may move the active window within its own tab order, or
    // push it out, or decline and let the window travel like any other. Upstream calls this
    // before touching the tree at all (:1521).
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

        // The group runs across the direction asked for. Wrap the whole group and step out
        // beside it; a one-child group left behind is cleaned up by measure.
        if (!movesAlong(o, dir)) {
            const wasRoot = parent === root;
            const g = newGroupAround(parent, focused, orientationForDirection(dir));
            makeNthSibling(focused, (dir === LEFT || dir === UP) ? 0 : 1);
            removeWindow(ogParent.data, ogIdx);
            if (wasRoot) newRoot = g;
            return { result: MOVE_DONE, root: newRoot };
        }

        // The group runs the right way, but we climbed here from below: join it at the level we
        // reached rather than descending again.
        //
        // Note the two indices disagree upstream and that is transcribed, not fixed: moving
        // right puts the node at idx + 1 but inserts its size at idx, so the leftover length
        // lands on the neighbour rather than on the window that just arrived. The vector still
        // sums exactly, so this is a small size difference and not a broken row.
        if (child !== focused) {
            insertChild(parent, focused, (dir === LEFT || dir === UP) ? idx : idx + 1);
            addWindow(parent.data, idx);
            removeWindow(ogParent.data, ogIdx);
            return { result: MOVE_DONE, root: newRoot };
        }

        // Is there a neighbour on that side at all?
        let nextIdx = null;
        if ((o === HORIZONTAL && dir === DOWN) || (o === VERTICAL && dir === RIGHT)) {
            if (idx < len - 1) nextIdx = idx + 1;
        } else if ((o === HORIZONTAL && dir === UP) || (o === VERTICAL && dir === LEFT)) {
            if (idx > 0) nextIdx = idx - 1;
        }

        if (nextIdx !== null) {
            const next = parent.children[nextIdx];

            // Moving a plain window into a neighbouring stack joins it rather than splitting
            // it. Only from a group of two: with more siblings around, the window has somewhere
            // of its own to go and upstream prefers that.
            if (isMapped(next.data) && isStack(next.data) &&
                isMapped(focused.data) && !isStack(focused.data) && len === 2) {
                detach(focused);
                // Pushed in from the left, it lands ahead of what is there; from any other
                // side it goes on the end.
                stackAdd(next.data, focused.data.windows, dir === RIGHT ? 0 : null);
                removeWindow(ogParent.data, ogIdx);
                return { result: MOVE_DONE, root: newRoot, shiftFocus: next };
            }

            if (isGroup(next.data) && len === 2) {
                // Descend into the neighbouring group. Which end depends on whether that group
                // runs the same way we are moving: if it does, we enter at the near end; if it
                // runs across us, there is no near end and we aim for the middle.
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
                    // An odd group has no middle to slot into, so the middle child is split
                    // instead, across the group's own orientation.
                    const old = next.children[idiv(groupLen, 2)];
                    newGroupAround(old, focused, go === HORIZONTAL ? VERTICAL : HORIZONTAL);
                    makeNthSibling(focused, entryIndex(dir));
                }
                removeWindow(ogParent.data, ogIdx);
                return { result: MOVE_DONE, root: newRoot };
            }

            if (len === 2) {
                // Just the two of us: swap places, and swap the sizes with them so neither
                // window changes size by moving.
                makeNthSibling(focused, nextIdx);
                swapWindows(parent.data, idx, nextIdx);
                return { result: MOVE_DONE, root: newRoot };
            }

            // A neighbour that is a window, in a group of more than two: split it and take the
            // half nearest where we came from.
            newGroupAround(next, focused, o);
            makeNthSibling(focused, entryIndex(dir));
            removeWindow(ogParent.data, ogIdx);
            return { result: MOVE_DONE, root: newRoot };
        }

        // The end of this group. Try the one above it.
        child = parent;
        parent = parent.parent;
    }

    return { result: MOVE_FURTHER, root: newRoot };
}

// ---------- drop zones ----------
//
// update_pointer_position :3386. Pure geometry: given a tree, a pointer and the zone currently
// committed, which zone is the pointer in. Nothing here touches time or the compositor; the
// dwell that turns a hovered zone into a committed one is below, and the adapter supplies the
// clock.
//
// One adaptation. Upstream resolves this against geometries_for_groupview — the overview's
// scaled-down layout — because a COSMIC drag happens in the workspace overview. KOSMIC has no
// such mode and drags on the live layout, so the geometry read here is the node's own. The zone
// arithmetic is unchanged; only where the rectangles come from differs.

export const ANIMATION_DURATION = 200;
export const MINIMIZE_ANIMATION_DURATION = 320;
export const MOUSE_ANIMATION_DELAY = 150;
export const INITIAL_MOUSE_ANIMATION_DELAY = 500;

// An edge band is 32px to enter and 80px to leave: once an edge is the committed zone it grows,
// so the pointer has to travel further back out than it did to get in. That hysteresis is what
// stops a band flickering when the pointer sits on its boundary.
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

// Walk down from the root through nodes containing the pointer. The descent stops at a group
// that already holds a drop zone: once a placeholder is open, the hover resolves at the group
// and the fine per-window zones are not consulted. This is deliberate upstream — aiming at a
// window moves that window, so the layout being read live would otherwise chase the pointer.
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

// The four edge bands of a group, carved in order: left, then top, then right, then bottom,
// each one shrinking what is left for the next. They are therefore not four symmetric strips —
// the top band spans the width already narrowed by the left band. Transcribed in that order
// because the corners belong to whichever band is carved first.
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

// Which gap between children the pointer sits in: the first child that starts after the pointer,
// minus one, clamped to the first. This is the index GroupInterior inserts after.
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

// The per-window zones :3644. The middle third in both axes is a stack; outside it the split
// side is the nearest edge *as a fraction of the window*, not in pixels, so a tall narrow window
// and a short wide one behave the same way.
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

// The zone the pointer is over right now. `held` is the committed zone, which only matters for
// widening the edge band it names.
//
// ACCEPTED DIVERGENCE, and the one place the zone logic is not a transcription.
//
// Upstream descends to the deepest node containing the pointer and only then asks what zone it
// is in, so a group's edge bands are reached only when the pointer is inside the group but
// outside every child. That works there because a COSMIC drag happens in the workspace
// overview, where geometries_for_groupview draws each group with padding — the bands live in
// that margin. KWin has no such mode and KOSMIC drags on the live layout, where children tile
// their group exactly apart from an 8px gap. Descending first therefore always lands on a
// window, and GroupEdge and GroupInterior become unreachable — the two zones that the N-ary
// tree exists for.
//
// So the bands are tested at each group on the way down, before descending into a child. The
// arithmetic of every zone is unchanged; what differs is that a group's outer band wins over
// the child beneath it instead of never being consulted.
export function zoneAt(root, p, held) {
    if (!root) return { kind: ZONE_INITIAL };
    if (!contains(root.data.geo, p)) return { kind: ZONE_INITIAL };

    let n = root;
    for (;;) {
        if (isPlaceholder(n.data)) return { kind: ZONE_INITIAL_PLACEHOLDER, node: n };

        if (isGroup(n.data)) {
            // A group already holding a drop zone stops the walk, exactly as upstream: once a
            // placeholder is open the hover resolves here, and the fine per-window zones are
            // not consulted. Aiming at a window moves it, so a live layout would otherwise
            // chase the pointer.
            if (hasDropZoneChild(n)) break;

            const heldEdge = (held && held.kind === ZONE_GROUP_EDGE && held.node === n)
                ? held.dir : null;
            const bands = edgeBands(n.data.geo, heldEdge);
            // Tested left, right, top, bottom — not in carving order. A corner carved into the
            // left band is still reported as Left, but one carved into the top band loses to
            // Right.
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

    // A group that fell through — because it holds a drop zone — is reported through its first
    // real window, so the caller always gets a window to split or stack onto.
    const target = isGroup(n.data)
        ? n.children.find((c) => isMapped(c.data)) || n
        : n;
    return windowZone(target, n.data.geo, p);
}

// A hovered zone is not the committed one until it has been held still. Leaving the dragged
// window's own placeholder is slower than any other move, so a drag that starts by twitching
// does not immediately tear the layout apart.
//
// Returns the zone to commit to, or null to keep the current one. `now` and `since` are
// milliseconds; the adapter owns the clock.
export function dwellElapsed(heldZone, since, now) {
    const delay = heldZone && heldZone.kind === ZONE_INITIAL_PLACEHOLDER
        ? INITIAL_MOUSE_ANIMATION_DELAY
        : MOUSE_ANIMATION_DELAY;
    return (now - since) > delay;
}

// drop_window :2666 — apply a committed zone. One arm per zone, and the tree it returns is the
// one to measure. The WindowStack arm is left to the stacks commit; until then a stack drop
// falls through to the default, which maps the window normally rather than losing it.
export function dropWindow(root, incoming, zone, outputSize) {
    if (!zone) return { root: mapToTree(root, incoming, null, null, outputSize), target: incoming };

    switch (zone.kind) {
        case ZONE_GROUP_EDGE: {
            const group = zone.node;
            const o = orientationForDirection(zone.dir);
            const first = (zone.dir === LEFT || zone.dir === UP);

            if (group.data.orientation !== o) {
                // The group runs the wrong way for this edge, so it is wrapped rather than
                // widened, and the window becomes its sibling. The group's own size vector is
                // untouched on this path.
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
            // The index is clamped rather than trusted: it was computed against a layout that
            // may have changed while the pointer dwelled.
            const idx = Math.min(dataLen(group.data), zone.idx + 1);
            addWindow(group.data, idx);
            insertChild(group, incoming, idx);
            return { root, target: incoming };
        }

        case ZONE_INITIAL_PLACEHOLDER: {
            // The dragged window's own placeholder: take its place and its rectangle, so
            // dropping where you started changes nothing.
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
            // The target becomes a stack if it is not one already, and the dropped window's
            // windows join it — a stack dropped onto a stack merges rather than nesting.
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

// ---------- floating ----------
//
// src/shell/layout/floating/. Floating is a layout, not an absence of one: workspace.rs holds a
// tiling_layer and a floating_layer side by side, and a window is mapped into one of them. It
// never "leaves the tree" — it is in the other layout.

// TiledCorners::relative_geometry :210. COSMIC's own snap targets for a floating window: four
// corners, four edges. Only the inner gap is used; the outer one does not apply here. The
// arithmetic matches the tiling model — `inner` on an outside edge, `inner / 2` either side of
// the midline — so the seam between two snapped halves is one whole inner gap, same as a seam
// between two tiled windows.
export const TILED_TOP = "top", TILED_BOTTOM = "bottom";
export const TILED_LEFT = "left", TILED_RIGHT = "right";
export const TILED_TOP_LEFT = "top-left", TILED_TOP_RIGHT = "top-right";
export const TILED_BOTTOM_LEFT = "bottom-left", TILED_BOTTOM_RIGHT = "bottom-right";

export function cornerGeometry(corner, work, gaps) {
    const g = gaps.inner;
    const halfW = idiv(work.w, 2), halfH = idiv(work.h, 2);
    const near = g, mid = idiv(g, 2);
    const shrinkHalf = idiv(g * 3, 2);   // inner * 3 / 2, truncated as in Rust

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

// map_anchored :455 — the size a floating window is given when it has no remembered one. A
// window that asks to be bigger than two thirds of the output is cut back to two thirds, but
// never past its own minimum or maximum, and never past the work area whatever it claims it
// needs. A zero in min or max means "unset" upstream and is ignored rather than honoured.
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

// ---------- workspace ----------
//
// workspace.rs. One tiling layer, one floating layer, and a flag saying whether this workspace
// tiles at all.

// `tiled` is the default for a workspace that has just come into being, which upstream keeps in
// cosmic-comp-config rather than in the layout. Absent means tiled, which is both COSMIC's default
// and what every sim that calls this with no argument has always got.
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
    // No position given means the one it had last time, which is what makes toggling a window
    // out and back in put it where it was rather than somewhere new.
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

// toggle_floating_window :1491. Note the guard: on a workspace that does not tile, this does
// nothing at all. There is no floating/tiled distinction to toggle when everything floats.
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

// toggle_tiling :1440 — the whole workspace moves, one layer to the other.
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

// ---------- stacks ----------
//
// toggle_stacking :2132 and CosmicStack::handle_move (element/stack.rs :432). A stack lives in
// the leaf, so none of this touches the tree's shape except when a stack is dissolved or a
// window is ejected from one.

export function isStack(d) { return d.kind === MAPPED && d.stacked; }

// Keep `ref` on the active window. Every mutation below goes through this rather than setting
// `ref` by hand, because a stale `ref` means the adapter writes geometry to the wrong window —
// a failure that looks like the layout being wrong rather than the bookkeeping.
function syncActive(d) {
    if (d.active < 0) d.active = 0;
    if (d.active > d.windows.length - 1) d.active = Math.max(0, d.windows.length - 1);
    d.ref = d.windows[d.active];
}

export function convertToStack(d) {
    d.stacked = true;
    syncActive(d);
}

// Add windows to a stack. `idx` of null appends, which is what a drop does; move_current_node
// passes 0 when a window is pushed in from the right, so it lands ahead of what is there.
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

// Tab through a stack. Clamped rather than wrapped, matching handle_move: running off the end is
// what ejects a window, so wrapping here would make that unreachable.
export function stackCycle(d, step) {
    const next = d.active + step;
    if (next < 0 || next >= d.windows.length) return false;
    d.active = next;
    syncActive(d);
    return true;
}

export const STACK_HANDLED = "handled", STACK_MOVE_OUT = "move-out", STACK_DEFAULT = "default";

// handle_move :432. Left and Right move the active window *within* the stack, swapping it with
// its neighbour so the tab order changes with it. Up and Down never move inside a stack, and
// neither does running off either end: both eject. A stack of one declines to handle the move at
// all, so it travels like an ordinary window.
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
    // Upstream steps back only when the removed window was the last one; otherwise the index is
    // left alone and now names what used to be the next window along.
    if (d.active === d.windows.length) d.active = d.active - 1;
    syncActive(d);
    return { result: STACK_MOVE_OUT, ref };
}

// toggle_stacking :2132. A plain window becomes a stack in place — the node does not move. A
// stack is dissolved the other way: the first window stays in this leaf and each of the rest is
// mapped in beside the previous one, so a stack of four becomes four tiled windows rather than
// four siblings in one group.
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

// ---------- tiling exceptions ----------
//
// shell/layout/mod.rs. Two independent reasons a window stays out of the tree: it looks like a
// dialog, or a rule says so. Both are predicates over facts about a window, so both live here;
// reading those facts out of KWin is the adapter's job.

// is_dialog :20. The first clauses are a window *saying* it is a dialog — a parent, a modal
// hint, an X11 type that is not Normal or Utility. The last one is a window giving itself away:
// a fixed size, where the minimum and maximum agree, cannot be tiled into an arbitrary slot
// whatever it calls itself.
//
// `desc` is a plain description — { transient, modal, dialog, override, utility, minSize,
// maxSize } — and not a KWin object. A missing field is simply false.
export function isDialog(desc) {
    if (!desc) return false;
    if (desc.transient || desc.modal || desc.dialog || desc.override) return true;

    const mn = desc.minSize, mx = desc.maxSize;
    if (mn && mx && (mn.w > 0 || mn.h > 0) && mn.w === mx.w && mn.h === mx.h) return true;
    return false;
}

// TilingExceptions::new :67. A rule is a pair of regexes and both have to compile; upstream
// warns and drops the whole rule when either fails, rather than treating an unparsable pattern
// as matching nothing. `onBad` reports the dropped rule so the adapter can log it — a rule that
// silently does nothing is the worst outcome for someone writing one.
// Both shapes are accepted. The data file writes `titles: [...]` and the config layer flattens
// each entry into one ApplicationException per title before TilingExceptions ever sees it, so a
// list here expands the same way rather than being a second format.
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

// data/tiling-exceptions.ron, transcribed. This replaces the hand-written FLOAT_CLASSES list the
// fork tree carried: that one matched a lowercased resource class exactly and could not express
// "this application, but only this window of it" — which is most of what is actually needed, and
// what the appid/title pair is for. Entries whose only purpose is a KDE process rather than an
// application are added at the bottom, marked, since COSMIC has no reason to list them.
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

    // Not from COSMIC: Plasma's own surfaces, which arrive as ordinary toplevels on KWin and
    // would otherwise be tiled. The fork tree listed these too and they are still needed.
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
    // The KDE counterpart of `gnome-screenshot` above, which COSMIC already excludes. Spectacle
    // runs as a service and its window exists while a capture is being taken but is not on the
    // screen, so tiling it reserves a slot that nothing is ever drawn into -- a rectangle of
    // wallpaper that no check here can see, because by every measure the module has, the window is
    // real, mapped, on this workspace and in exactly one leaf.
    { appid: "^(org\\.kde\\.)?spectacle$", titles: [".*"] },
];

// has_floating_exception :93. The match is an AND *within* one rule and an OR across rules:
// upstream runs two RegexSets and then requires the same index to have matched in both, so a
// rule whose appid matches one window and whose title matches a different one matches neither.
//
// An empty pattern matches everything, which is how a rule names an application regardless of
// title — and also why a rule with both fields empty floats every window. That is upstream's
// behaviour and not a guard worth adding here.
export function hasFloatingException(exceptions, appId, title) {
    const id = appId === undefined || appId === null ? "" : String(appId);
    const t = title === undefined || title === null ? "" : String(title);
    for (const rule of exceptions || []) {
        if (rule.appid.test(id) && rule.title.test(t)) return true;
    }
    return false;
}

