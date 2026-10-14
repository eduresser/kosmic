// SPDX-FileCopyrightText: 2024 System76, Inc. <info@system76.com>
// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// KOSMIC's adapter: KWin on one side, core.mjs on the other.
//
// Everything about *what the layout is* lives in core.mjs, which is a transcription of
// cosmic-comp's src/shell/layout/tiling/mod.rs and knows nothing about KWin. This file is the
// other half: it reads windows out of KWin, hands the core plain descriptions, and writes the
// geometry the core worked out back. Nothing here decides where a window goes.
//
// The division is not cosmetic. The core is testable without a compositor and is checked against
// numbers taken from the Rust; this file is where the compositor's own behaviour has to be
// absorbed -- clients that refuse the size they are given, fractional scaling, drags whose end
// never arrives, KWin having no notion of a window that is mapped but not shown.
//
// GPL-3.0. cosmic-comp is System76's, and so is the behaviour; the KWin plumbing is KOSMIC's.

import * as C from "./core.mjs";

let ws, kw, ui, dbg;

// One core workspace per (output, desktop). COSMIC gives each output its own set of workspaces;
// KWin's virtual desktops are global and there is no API to make them otherwise, so a desktop
// seen on two monitors is two spaces here.
const spaces = new Map();        // "output|desktop" -> core workspace
const windowOf = new Map();      // ref -> KWin window
const homeOf = new Map();        // ref -> key of the space it is mapped into
const connected = new Set();
const lastSibling = new Map();   // ref -> ref it sat beside before being minimized

const minimums = new Map();      // ref -> {w, h} smallest frame the client accepted
const lastSeen = new Map();      // ref -> geometry seen by the previous enforce pass
const overflowSince = new Map(); // ref -> when a window first stayed larger than its slot
const borderSaved = new Map();   // ref -> whether it had no decoration before it was stacked
const MIN_FLOOR = { w: 200, h: 120 };

let cur = null, prev = null;
let manual = false;              // a drag or a keyboard resize is in progress; keep our hands off
let grab = null;
let phSeq = 0, stackSeq = 0;

// Settings live in kwinrc under [Script-kosmic-tiling], written there by the applet or by
// install.sh, and read here when the script starts. The values below are the defaults, and they
// are the same ones the generated contents/config/main.xml declares -- both sides come from
// settings.json, and tools/parity.mjs fails if they stop agreeing.
let GAP_INNER = 8;
let GAP_OUTER = 0;
let DEBUG = false;
let DROP_PREVIEW = true;
let TAB_BAR = true;
let BAR_HEIGHT = 28;
let NEW_WORKSPACE_TILED = true;
let barH = BAR_HEIGHT;
let inner = 8, outer = 0;

// The exceptions are compiled once: each rule is a pair of regexes and building them per window
// per pass would recompile a hundred of them on every layout.
const exceptions = C.compileExceptions(C.DEFAULT_EXCEPTIONS,
    (rule, err) => log("bad tiling exception " + JSON.stringify(rule) + ": " + err));

export function log(m) { if (dbg) dbg(String(m)); }

// ---------- rects ----------
// KWin speaks {x, y, width, height}; the core speaks {x, y, w, h}. The two words are kept apart
// on purpose -- a rect that crosses this boundary in the wrong shape reads as a layout bug.
const clone = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
const toGeo = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
const toRect = (g) => ({ x: g.x, y: g.y, width: g.w, height: g.h });
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const north = (r) => [r.x + r.width / 2, r.y];
const east = (r) => [r.x + r.width, r.y + r.height / 2];
const south = (r) => [r.x + r.width / 2, r.y + r.height];
const west = (r) => [r.x, r.y + r.height / 2];
const fg = (w) => ({ x: w.frameGeometry.x, y: w.frameGeometry.y, width: w.frameGeometry.width, height: w.frameGeometry.height });

// ---------- windows ----------
// Declarative (QML) KWin scripts expose the list as the `windows` property; the JS API has windowList().
function allWindows() {
    if (typeof ws.windowList === "function") return ws.windowList();
    return Array.from(ws.windows || []);
}
const refOf = (w) => w.internalId.toString();
const winOf = (ref) => windowOf.get(ref);
const keyOf = (w) => {
    const d = w.desktops.length > 0 ? w.desktops[0].id : "0";
    return (w.output ? w.output.name : "?") + "|" + d;
};
function workArea(w) {
    const d = w.desktops.length > 0 ? w.desktops[0] : ws.currentDesktop;
    return clone(ws.clientArea(kw.MaximizeArea, w.output, d));
}
const appIdOf = (w) => String(w.resourceClass || "");
const captionOf = (w) => { try { return String(w.caption || ""); } catch (e) { return ""; } };

// The facts core.isDialog asks about, read out of KWin. A size is only reported when the client
// gave one: a zero means "unset" upstream and the predicate relies on that.
function describe(w) {
    let mn = null, mx = null;
    try {
        const a = w.minSize, b = w.maxSize;
        if (a) mn = { w: a.width, h: a.height };
        if (b) mx = { w: b.width, h: b.height };
    } catch (e) {}
    return {
        transient: !!w.transient, modal: !!w.modal, dialog: !!w.dialog,
        utility: !!w.utility, minSize: mn, maxSize: mx,
    };
}

function isTilable(w) {
    if (!w || !w.normalWindow || w.specialWindow) return false;
    if (w.desktops.length !== 1) return false;
    if (!w.resourceClass || appIdOf(w).trim() === "") return false;
    if (!w.moveable || !w.resizeable) return false;
    if (C.isDialog(describe(w))) return false;
    if (C.hasFloatingException(exceptions, appIdOf(w), captionOf(w))) return false;
    return true;
}

function isMaximized(w) {
    try {
        const n = Number(w.maximizeMode);
        if (!Number.isNaN(n)) return n !== 0;
    } catch (e) { return false; }
    if (outer < 3) return false;   // without a gap a lone tiled window is indistinguishable from a maximized one
    const a = workArea(w), g = fg(w);
    return Math.abs(g.x - a.x) < 3 && Math.abs(g.y - a.y) < 3 &&
        Math.abs(g.width - a.width) < 3 && Math.abs(g.height - a.height) < 3;
}

const attached = (w) => homeOf.has(refOf(w));
const canTile = (w) => isTilable(w) && !w.minimized && !w.fullScreen;
const shouldTile = (w) => canTile(w) && !isMaximized(w);

// ---------- spaces ----------
function spaceFor(key) {
    let sp = spaces.get(key);
    if (!sp) { sp = C.newWorkspace(NEW_WORKSPACE_TILED); sp.area = null; spaces.set(key, sp); }
    return sp;
}
const spaceOf = (ref) => spaces.get(homeOf.get(ref));

// Any window the space currently holds, which is the only way to ask KWin for the work area of a
// (output, desktop) pair: clientArea wants the objects, not the string the two were folded into.
function sampleRef(key) {
    for (const [ref, k] of homeOf) if (k === key) return ref;
    return null;
}
function sampleWindow(key) {
    for (const [ref, k] of homeOf) {
        if (k !== key) continue;
        const w = winOf(ref);
        if (w && w.desktops.length > 0) return w;
    }
    return null;
}
function areaOf(key) {
    const w = sampleWindow(key);
    if (!w) return null;
    return toGeo(workArea(w));
}

// Every mapped node whose leaf holds `ref`, which is not the same question as core's findMapped:
// that one compares against the node's active window, and a window hidden inside a stack is not
// the active one.
function nodeHolding(root, ref) {
    if (!root) return null;
    for (const n of C.preOrder(root)) {
        if (C.isMapped(n.data) && n.data.windows.indexOf(ref) >= 0) return n;
    }
    return null;
}
function nodeFor(ref) {
    const sp = spaceOf(ref);
    return sp ? nodeHolding(sp.tiling, ref) : null;
}
const isHidden = (ref) => {
    const n = nodeFor(ref);
    return !!n && C.isMapped(n.data) && n.data.ref !== ref;
};

// ---------- the write path ----------
//
// Collect what the layout asked for, then write it once. Everything between a core call and
// KWin's frameGeometry setter is here.
let requested = new Map();
const applied = new Map();   // ref -> last rect we asked for
// ref -> { want, at }: the rect a client was handed and where it stayed instead. Both halves are
// needed. A refusal is the statement "handed this, from here, it did not move", and it stops being
// true the moment the window moves -- a window that has since been put somewhere else has not
// answered the question again, and treating the old answer as current is how one ends up stranded
// far from its slot with the layout politely declining to correct it.
const refused = new Map();
const rectKey = (r) => Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.width) + "x" + Math.round(r.height);

// A client never lands exactly on the integer rect it was handed. KWin snaps it to the device pixel
// grid, so at a scale of 1.6 a width of 788 comes back as 788.125, and a terminal rounds its size
// down to whole character cells on top of that. One logical pixel, inclusive: `< 1` excluded a
// window that came back exactly one pixel short, which is what Konsole does on every single tile,
// and every one of them was then recorded as having refused its slot.
const TOLERANCE = 1;
const inPlace = (c, g) =>
    Math.abs(c.x - g.x) <= TOLERANCE && Math.abs(c.y - g.y) <= TOLERANCE &&
    Math.abs(c.width - g.width) <= TOLERANCE && Math.abs(c.height - g.height) <= TOLERANCE;

// One action often lays a tree out more than once -- unmapping a window re-measures what is left
// before the window is put back. Applying the intermediate geometry restarts the geometry
// animation halfway through, which is what makes the windows flicker, so everything a single
// action asks for is collected and written once, at the end.
let batch = 0;
function batched(fn) {
    batch += 1;
    try { fn(); } finally { batch -= 1; }
    arrange();
}

// The slot goes to the whole stack, not only to the window the tree names, so a member that comes
// forward is already the right size instead of resizing in front of the user. The tab bar takes
// the top of the slot and the windows start below it.
function record(n, g) {
    const d = n.data;
    const r = toRect(g);
    if (!d.stacked) {
        const w = winOf(d.ref);
        if (w) requested.set(d.ref, { w, r });
        return;
    }
    const s = stackUi(d);
    s.bar = { x: r.x, y: r.y, width: r.width, height: barH };
    const under = { x: r.x, y: r.y + barH, width: r.width, height: r.height - barH };
    for (const ref of d.windows) {
        const w = winOf(ref);
        if (w) requested.set(ref, { w, r: clone(under) });
    }
}

function arrange() {
    if (batch > 0) return;
    const items = requested;
    requested = new Map();
    for (const [ref, { w, r }] of items) {
        const g = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        applied.set(ref, g);
        if (w.tile) w.tile = null;
        const c = w.frameGeometry;
        // Already where it was put, give or take the pixel nothing can land on exactly. Writing it
        // again only replays the geometry animation, which is what reads as every window on the
        // screen twitching at once.
        if (inPlace(c, g)) { refused.delete(ref); continue; }
        // The client was handed this very rect, from exactly where it still is, and did not move.
        // Asking again cannot change its answer; it only restarts the client's own resize, which is
        // what looks like two windows fighting over the screen. cosmic-comp does the same by other
        // means: a new tree is only pushed once every window has acked the last one (TilingBlocker,
        // CosmicMapped::latest_size_committed).
        const no = refused.get(ref);
        if (no && no.want === rectKey(g) && no.at === rectKey(c)) {
            if (DEBUG) log("skip refused " + w.resourceClass + " want=" + rectKey(g) + " is=" + rectKey(c));
            continue;
        }
        if (DEBUG) log("write " + w.resourceClass + " " + rectKey(c) + " -> " + rectKey(g));
        w.frameGeometry = Qt.rect(g.x, g.y, g.width, g.height);
    }
    syncBars();
    showDragPreview();
    updateSelection();
}

// Lay one space out and write the result. This is the only path from the core to the screen.
function layout(key) {
    const sp = spaces.get(key);
    if (!sp) return;
    const area = areaOf(key);
    // A space with no window and nothing to say is dropped, because it is indistinguishable from
    // one that was never created -- but a space whose tiling flag differs from the default for a
    // new one is a decision the user made, usually before opening anything on that workspace, and
    // collecting it would undo that decision the moment it was taken.
    if (!area) {
        if (!sp.tiling && sp.tilingEnabled === NEW_WORKSPACE_TILED) spaces.delete(key);
        return;
    }
    sp.area = area;
    const gaps = { outer: outer, inner: inner };
    let r = C.measure(sp.tiling, area, gaps);
    sp.tiling = r.root;
    // The minimum sizes are applied between measures rather than before one: they are read
    // against the geometry this layout produced, not against whatever the last one left behind.
    // Twice over, because the two are circular -- whether a group can turn depends on how wide
    // its parent made it, and how wide the parent should make it depends on which way it turned.
    // Three passes is a stop, not a budget: the second one settles every case the suite has, and
    // a layout that is still moving after three is one no further pass is going to fix.
    for (let pass = 0; pass < 3; pass++) {
        const fix = clampSizes(sp.tiling);
        sp.infeasible = fix.infeasible;
        if (!fix.changed) break;
        r = C.measure(sp.tiling, area, gaps);
        sp.tiling = r.root;
    }
    for (const c of r.configures) record(c.node, c.geo);
    arrange();
}
function layoutAll() { for (const key of Array.from(spaces.keys())) layout(key); }
const layoutOf = (ref) => { const k = homeOf.get(ref); if (k) layout(k); };

// ---------- minimum sizes ----------
//
// ACCEPTED DIVERGENCE. cosmic-comp's tiling has no notion of a minimum size: it hands out the
// slot and lets whatever does not fit spill over its neighbour. That is visible and ugly on a
// desktop full of KDE applications, several of which refuse to go below a size that is larger
// than half the screen, so KOSMIC keeps the size vector away from a slot a window is known not to
// accept. What was dropped along with the fork tree is the other half of the old rule -- flipping
// a group's orientation to make two windows fit -- because that one has no upstream counterpart
// at all and was what made two stubborn windows alternate between side by side and stacked.
//
// The minimum itself is learned from what the client actually did, not from what it declares:
// most declare nothing and simply refuse.
function declaredMin(w) {
    try {
        const m = w.minSize;
        if (m && m.width > 0 && m.height > 0) return { width: Math.min(m.width, 1400), height: Math.min(m.height, 900) };
    } catch (e) {}
    return { width: 0, height: 0 };
}

// The slice of a group's length a node needs along `o`, gaps included. A group that runs the same
// way needs the sum of its children and one that runs across them needs the largest -- with no
// term of its own either way, because measure() divides a group's length among its children
// exactly and the gaps come out of each leaf's own rectangle, not out of the seams.
function minAlong(n, o) {
    const d = n.data;
    if (C.isGroup(d)) {
        let sum = 0, max = 0;
        for (const c of n.children) { const v = minAlong(c, o); sum += v; max = Math.max(max, v); }
        return d.orientation === o ? sum : max;
    }
    const floor = o === C.VERTICAL ? MIN_FLOOR.w : MIN_FLOOR.h;
    let v = floor;
    if (!C.isPlaceholder(d)) {
        for (const ref of d.windows) {
            const w = winOf(ref);
            if (!w) continue;
            const k = minimums.get(ref), dm = declaredMin(w);
            v = Math.max(v, o === C.VERTICAL ? Math.max(k ? k.w : 0, dm.width) : Math.max(k ? k.h : 0, dm.height));
        }
        if (d.stacked && o === C.HORIZONTAL) v += barH;
    }
    // The same arithmetic measure() uses: half an inner gap on a side with a neighbour, a whole one
    // on a side without. Reserving a flat `inner` instead left a leaf between two edges four pixels
    // short of the minimum it had just been taught.
    const near = o === C.VERTICAL ? C.LEFT : C.UP;
    const far = o === C.VERTICAL ? C.RIGHT : C.DOWN;
    v += C.hasAdjacentNode(n, near) ? C.idiv(inner, 2) : inner;
    v += C.hasAdjacentNode(n, far) ? C.idiv(inner, 2) : inner;
    return v;
}

// Whether a group can hold its children laid out along `q`: they have to fit end to end along
// that axis, and the largest of them has to fit across it. Both halves matter -- checking only
// the split axis is what used to make two stubborn windows alternate between side by side and
// stacked on every pass, each orientation looking fine by the rule that chose it.
function fitsAlong(n, q) {
    const cross = q === C.VERTICAL ? C.HORIZONTAL : C.VERTICAL;
    let sum = 0, widest = 0;
    for (const c of n.children) { sum += minAlong(c, q); widest = Math.max(widest, minAlong(c, cross)); }
    return sum <= C.lengthOf(q, n.data.geo) && widest <= C.lengthOf(cross, n.data.geo);
}

// Raise any child whose share is below its minimum, taking the difference from whoever has the
// most to spare. A group that cannot hold its children at all turns first -- two windows that do
// not fit side by side may fit stacked -- and only if neither way round works is it shared out in
// proportion to the minimums and left to overlap, which is upstream's outcome reached on purpose
// rather than by the layout giving up halfway.
//
// Runs between two measures, so every geometry it reads is this layout's and not the last one's.
// Answers whether it changed anything, and whether it had to give up on a group: a space whose
// windows overlap by arithmetic must not be re-measured every time they are noticed to overlap.
function clampSizes(root) {
    let changed = false, infeasible = false;
    if (!root) return { changed, infeasible };

    // Orientation first, and from the leaves up: a group's minimum depends on which way its own
    // children run, so asking a parent before its children have settled reads a figure that is
    // about to change. Reversing a pre-order walk visits every descendant before its ancestor.
    const groups = C.preOrder(root).filter((n) => C.isGroup(n.data) && n.data.sizes.length === n.children.length);
    for (let k = groups.length - 1; k >= 0; k--) {
        const n = groups[k], d = n.data;
        const o = d.orientation;
        const other = o === C.VERTICAL ? C.HORIZONTAL : C.VERTICAL;
        if (fitsAlong(n, o) || !fitsAlong(n, other)) continue;
        const from = C.lengthOf(o, d.geo), to = C.lengthOf(other, d.geo);
        if (from > 0) for (let i = 0; i < d.sizes.length; i++) d.sizes[i] = C.roundI32((d.sizes[i] / from) * to);
        const sum = d.sizes.reduce((a, b) => a + b, 0);
        if (d.sizes.length > 0) d.sizes[d.sizes.length - 1] += to - sum;
        d.orientation = other;
        changed = true;
    }

    for (const n of groups) {
        const d = n.data;
        const o = d.orientation;
        const need = n.children.map((c) => minAlong(c, o));
        const total = d.sizes.reduce((a, b) => a + b, 0);
        const want = need.reduce((a, b) => a + b, 0);
        if (want <= 0 || total <= 0) continue;

        if (want >= total) {
            infeasible = true;
            let used = 0;
            for (let i = 0; i < d.sizes.length - 1; i++) {
                const v = C.roundI32((total * need[i]) / want);
                if (v !== d.sizes[i]) changed = true;
                d.sizes[i] = v;
                used += v;
            }
            if (d.sizes[d.sizes.length - 1] !== total - used) changed = true;
            d.sizes[d.sizes.length - 1] = total - used;
            continue;
        }
        for (;;) {
            let lo = -1, hi = -1;
            for (let i = 0; i < d.sizes.length; i++) {
                if (d.sizes[i] < need[i] && (lo < 0 || need[i] - d.sizes[i] > need[lo] - d.sizes[lo])) lo = i;
                if (d.sizes[i] > need[i] && (hi < 0 || d.sizes[i] - need[i] > d.sizes[hi] - need[hi])) hi = i;
            }
            if (lo < 0 || hi < 0) break;
            const take = Math.min(need[lo] - d.sizes[lo], d.sizes[hi] - need[hi]);
            if (take <= 0) break;
            d.sizes[lo] += take;
            d.sizes[hi] -= take;
            changed = true;
        }
    }
    return { changed, infeasible };
}

// ---------- map and unmap ----------
//
// map_to_tree :548 and unmap_internal :1446 with the KWin bookkeeping around them. A window is
// *mapped into a space* -- either its tiling layer or its floating one -- and homeOf says which
// space, which is what makes unmapping a window whose desktop has already changed possible.

// The node a new window splits. COSMIC splits the focused one; KWin's "focused" is whatever was
// activated last, and the window being mapped has usually taken that already, so the one before
// it is the honest answer.
function splitTarget(sp, key) {
    for (const w of [cur, prev]) {
        if (!w || !attached(w) || w.minimized) continue;
        if (homeOf.get(refOf(w)) !== key) continue;
        const n = nodeHolding(sp.tiling, refOf(w));
        if (n) return n;
    }
    return null;
}

function mapWindow(w, direction) {
    const ref = refOf(w);
    windowOf.set(ref, w);
    // Unconditionally, and from every space, rather than only when homeOf says it is attached:
    // mapping a window some tree still holds gives one ref two leaves, and only one of them can be
    // written to. The other is a hole.
    for (const k of unmapRef(ref)) layout(k);
    const key = keyOf(w);
    const sp = spaceFor(key);
    const area = toGeo(workArea(w));
    sp.area = area;

    if (!sp.tilingEnabled) {
        C.mapFloating(sp, ref, toGeo(fg(w)));
        homeOf.set(ref, key);
        return;
    }
    const target = direction ? null : splitTarget(sp, key);
    sp.tiling = C.mapToTree(sp.tiling, C.node(C.newMapped(ref)), target, direction || null, area);
    homeOf.set(ref, key);
    layout(key);
}

// Takes `ref` out of whichever layer holds it. A member of a stack leaves the stack rather than
// the tree: the slot belongs to the rest of them.
// Takes `ref` out of every layer of every space that still holds it, and answers which spaces were
// touched so the caller can measure them.
//
// It does not trust homeOf. A node the tree holds and homeOf has forgotten is invisible to every
// other part of this file, and it is the one failure that shows on the screen as a rectangle of
// wallpaper: the slot is measured, nothing is written into it, and nothing ever notices. Searching
// every space costs a walk of a tree that has tens of nodes.
function unmapRef(ref) {
    const touched = [];
    homeOf.delete(ref);
    for (const [key, sp] of spaces) {
        let hit = false;
        if (C.floatingIndex(sp, ref) >= 0) { C.unmapFloating(sp, ref); hit = true; }
        // A loop, not an if: two nodes naming one window is exactly the state being repaired.
        for (;;) {
            const n = nodeHolding(sp.tiling, ref);
            if (!n) break;
            hit = true;
            const d = n.data;
            if (d.windows.length > 1) {
                const i = d.windows.indexOf(ref);
                d.windows.splice(i, 1);
                // Upstream steps back only when the window removed was the last one, which is what
                // handleStackMove does too; the clamp inside stackSetActive finishes the job.
                C.stackSetActive(d, i === d.windows.length ? i - 1 : d.active > i ? d.active - 1 : d.active);
                continue;
            }
            dropStackUi(d);
            sp.tiling = C.unmapInternal(sp.tiling, n);
        }
        if (hit) touched.push(key);
    }
    return touched;
}

function unmapWindow(w) {
    for (const key of unmapRef(refOf(w))) layout(key);
}

// A window that left the tree keeps nothing it was told about the slot it used to have.
function forget(ref) {
    applied.delete(ref);
    refused.delete(ref);
    lastSeen.delete(ref);
}

// ---------- floating ----------
//
// The floating layer is COSMIC's, but where a floating window actually goes is KDE's: Plasma
// already places, cascades and remembers windows that are not tiled, and KOSMIC has no reason to
// have an opinion about that. What is kept from upstream is the
// size a window gets the first time it floats -- map_anchored's two-thirds rule -- because
// otherwise a window untiled from a narrow slot stays that shape.
function placeFloating(w, sp) {
    const ref = refOf(w);
    const remembered = sp.lastFloating.get(ref);
    const area = sp.area || toGeo(workArea(w));
    let g;
    if (remembered) {
        g = remembered;
    } else {
        const d = describe(w);
        const size = C.floatingSize(toGeo(fg(w)), area, d.minSize, d.maxSize);
        g = {
            x: area.x + C.idiv(area.w - size.w, 2),
            y: area.y + C.idiv(area.h - size.h, 2),
            w: size.w, h: size.h,
        };
    }
    const i = C.floatingIndex(sp, ref);
    if (i >= 0) sp.floating[i].geo = g;
    requested.set(ref, { w, r: toRect(g) });
}

function toggleFloating() {
    const w = ws.activeWindow;
    if (!w) return;
    const ref = refOf(w);
    const sp = spaceOf(ref);
    if (!sp) { if (shouldTile(w)) mapWindow(w, null); return; }
    const key = homeOf.get(ref);
    const wasTiled = !!nodeHolding(sp.tiling, ref);
    if (!C.toggleFloatingWindow(sp, ref, sp.area || areaOf(key), cur ? refOf(cur) : null)) return;
    forget(ref);
    if (wasTiled) placeFloating(w, sp);
    layout(key);
    ws.activeWindow = w;
}

// The space the user is looking at. Not simply the active window's: focus can sit on a window of
// another desktop, and "toggle tiling" said there would toggle a workspace that is not on screen
// and leave the one that is alone -- which from the keyboard is indistinguishable from the key
// doing nothing.
function currentKey() {
    const now = ws.currentDesktop ? ws.currentDesktop.id : null;
    const here = (m) => m && m.desktops.length === 1 && (!now || m.desktops[0].id === now);
    const w = ws.activeWindow;
    if (here(w)) return homeOf.get(refOf(w)) || keyOf(w);
    for (const m of allWindows()) {
        if (!here(m) || !isTilable(m)) continue;
        return homeOf.get(refOf(m)) || keyOf(m);
    }
    // Nothing is open here. The space does not exist yet, but the question still has an answer:
    // deciding how a workspace behaves before filling it is the ordinary way round, and upstream's
    // applet toggles an empty workspace like any other. The key is the same (output, desktop) pair
    // keyOf builds, with the active output standing in for the window's -- a window that later
    // opens on a different output lands in a different space, which is the per-output model this
    // module already has.
    if (!ws.currentDesktop) return null;
    const out = ws.activeScreen;
    return (out && out.name ? out.name : "?") + "|" + ws.currentDesktop.id;
}

function toggleTiling() {
    const key = currentKey();
    if (key === null) return;
    const w = winOf(sampleRef(key)) || ws.activeWindow;
    const sp = spaceFor(key);
    const area = sp.area || areaOf(key) || (w ? toGeo(workArea(w)) : null);
    // An empty space needs no area. core.setTilingEnabled reads it only to re-map the windows it
    // is moving between the two layers, and there are none; refusing here instead is what made the
    // control dead on an empty workspace.
    if (!area && (sp.tiling || sp.floating.length)) return;
    C.setTilingEnabled(sp, !sp.tilingEnabled, area);
    for (const f of sp.floating) { const m = winOf(f.ref); if (m) placeFloating(m, sp); }
    for (const [ref, k] of homeOf) if (k === key) forget(ref);
    layout(key);
    publishTiling(false);
}

// ---------- publishing the state ----------
//
// The one thing in here anybody outside can read, and it exists for one reader: the panel applet,
// whose "Tile current workspace" is a switch and therefore has to be told what to show. A KWin
// script can only call outwards, so this pushes rather than answers -- see state/.
//
// Gated on the value, not on the event. A workspace change between two tiled workspaces says
// nothing new, and the hot path should not pay a D-Bus call to repeat itself. `force` is for the
// applet's own request, which has to be answered even when nothing has changed, because the point
// of that request is to prove something is still alive to answer it.
let published = null;
function publishTiling(force) {
    if (!ui || typeof ui.publishTiling !== "function") return;
    const key = currentKey();
    const sp = key === null ? null : spaces.get(key);
    // No space yet means no window has opened here, and the space will be born with the default --
    // so that is the honest answer, not "unknown".
    const on = sp ? sp.tilingEnabled : NEW_WORKSPACE_TILED;
    if (!force && on === published) return;
    published = on;
    ui.publishTiling(on);
}

// ---------- focus ----------
//
// Which window is next in a direction is answered geometrically rather than through the tree.
// ACCEPTED DIVERGENCE: COSMIC walks the tree for this, and on a layout where tiles cannot
// overlap the two answers agree; where they do not -- a window that refused its slot and is
// sitting on top of its neighbour -- the geometric answer is the one the user is looking at.
function visibleTiled() {
    const out = [];
    for (const [ref, key] of homeOf) {
        const w = winOf(ref);
        if (!w || w.minimized || w.desktops.length === 0) continue;
        if (ws.currentDesktop && w.desktops[0].id !== ws.currentDesktop.id) continue;
        if (isHidden(ref)) continue;
        void key;
        out.push(w);
    }
    return out;
}
function neighbor(w, dir) {
    const a = fg(w);
    const filt = {
        left: (b) => b.x < a.x, right: (b) => b.x > a.x, up: (b) => b.y < a.y, down: (b) => b.y > a.y,
    }[dir];
    const d = {
        left: (b) => dist(east(b), west(a)),
        right: (b) => dist(west(b), east(a)),
        up: (b) => dist(south(b), north(a)),
        down: (b) => dist(north(b), south(a)),
    }[dir];
    const list = visibleTiled().filter((o) => o !== w && filt(fg(o))).sort((x, y) => d(fg(x)) - d(fg(y)));
    return list.length ? list[0] : null;
}
export function focusDir(dir) {
    const w = ws.activeWindow;
    if (!w) return;
    const n = neighbor(w, dir);
    if (n) ws.activeWindow = n;
}

// ---------- selection: Focus(In) and Focus(Out) ----------
//
// focus_direction :1286. COSMIC's focus is a *node*, not a window: Super+U moves it to the group
// around the focused window and Super+I walks back down. Everything that takes a node -- resize,
// move, orientation -- then applies to the whole group.
//
// KWin has no idea a group can be focused, so the selection lives here and the active window is
// unchanged while it is raised. The focusdim effect dims everything the selection does not cover,
// which is the only thing that makes the mode visible at all; without it Super+U would silently
// change what the next key does.
let selected = null;   // a node, or null meaning "the active window's own node"

function selectedNode() {
    if (selected) return selected;
    const w = ws.activeWindow;
    return w ? nodeFor(refOf(w)) : null;
}
function clearSelection() {
    if (!selected) return;
    selected = null;
    updateSelection();
}
// A selection the tree no longer contains is no selection. Cheap, and it runs before every use.
function liveSelection() {
    if (!selected) return null;
    let n = selected;
    while (n.parent) n = n.parent;
    for (const sp of spaces.values()) if (sp.tiling === n) return selected;
    selected = null;
    return null;
}
function focusOut() {
    liveSelection();
    const n = selectedNode();
    if (!n || !n.parent) return;
    selected = n.parent;
    updateSelection();
}
function focusIn() {
    if (!liveSelection()) return;
    const w = ws.activeWindow;
    const ref = w ? refOf(w) : null;
    let next = selected.children[0];
    if (ref) {
        for (const c of selected.children) {
            if (nodeHolding(c, ref)) { next = c; break; }
        }
    }
    selected = (next && C.isGroup(next.data)) ? next : null;
    updateSelection();
}

// ---------- stacks ----------
//
// A stack is one leaf shared by several windows (core: Data::Mapped with `stacked`). KWin cannot
// hide a window except by minimizing it, which would take it out of the task manager and out of
// Alt+Tab, so every member is given the same rect and the active one is raised over the rest.
// The tab bar is what says the others are there.
const stacksUi = new Map();   // stack id -> { id, data, bar, item }
function stackUi(d) {
    if (!d.stackId) d.stackId = ++stackSeq;
    let s = stacksUi.get(d.stackId);
    if (!s) { s = { id: d.stackId, data: d, bar: null, item: null }; stacksUi.set(d.stackId, s); }
    s.data = d;
    return s;
}
function dropStackUi(d) {
    if (!d || !d.stackId) return;
    const s = stacksUi.get(d.stackId);
    if (!s) return;
    if (s.item) { try { s.item.destroy(); } catch (e) {} }
    stacksUi.delete(d.stackId);
}
const stackName = (w) => { try { return String(w.caption || w.resourceClass); } catch (e) { return String(w.resourceClass); } };
function osd(text) { try { if (ui && ui.osd) ui.osd(String(text)); } catch (e) {} }

// A stacked window gives up its decoration: the tab bar stands in for the title bar, which is
// where KDE 4.4 put window tabs. Client-side decorated applications draw their own and are
// unaffected.
function setStacked(ref, on) {
    if (!TAB_BAR) return;
    const w = winOf(ref);
    if (!w) return;
    try {
        if (on) {
            if (!borderSaved.has(ref)) borderSaved.set(ref, !!w.noBorder);
            w.noBorder = true;
        } else if (borderSaved.has(ref)) {
            w.noBorder = borderSaved.get(ref);
        }
    } catch (e) {}
    if (!on) borderSaved.delete(ref);
}
function syncDecorations(d) {
    for (const ref of d.windows) setStacked(ref, !!d.stacked);
}

function barVisible(s) {
    const d = s.data;
    if (!TAB_BAR || !s.bar || !d.stacked) return false;
    const w = winOf(d.ref);
    if (!w || w.minimized || w.fullScreen || w.desktops.length === 0) return false;
    return !ws.currentDesktop || w.desktops[0].id === ws.currentDesktop.id;
}
function iconOf(w) { try { return w.icon; } catch (e) { return null; } }
function syncBars() {
    if (!TAB_BAR || !ui || !ui.newBar) return;
    for (const s of stacksUi.values()) {
        if (!barVisible(s)) { if (s.item) { try { s.item.visible = false; } catch (e) {} } continue; }
        if (!s.item) s.item = ui.newBar();
        if (!s.item) continue;
        const tabs = [];
        for (const ref of s.data.windows) {
            const w = winOf(ref);
            if (!w) continue;
            tabs.push({ title: stackName(w), icon: iconOf(w), iconName: appIdOf(w).toLowerCase() });
        }
        try { s.item.apply(s.id, s.bar, tabs, s.data.active); } catch (e) { log("bar: " + e); }
    }
}

// Bring a member forward. The window is activated rather than merely raised: that is the only
// signal KWin gives the rest of the desktop, and the task manager and Alt+Tab both read it.
function setActiveMember(d, idx) {
    if (!d.stacked || idx < 0 || idx >= d.windows.length) return;
    C.stackSetActive(d, idx);
    const w = winOf(d.ref);
    if (w) {
        if (ws.activeWindow !== w) ws.activeWindow = w;
        if (d.windows.length > 1) osd(stackName(w));
    }
}

export function tabActivate(id, i) {
    batched(() => {
        const s = stacksUi.get(id);
        if (!s) return;
        setActiveMember(s.data, i);
        layoutOf(s.data.ref);
    });
}
export function tabClose(id, i) {
    const s = stacksUi.get(id);
    const w = s && winOf(s.data.windows[i]);
    if (w) { try { w.closeWindow(); } catch (e) { log("close: " + e); } }
}

function toggleStack() {
    const w = ws.activeWindow;
    if (!w || !attached(w)) return;
    const ref = refOf(w);
    const sp = spaceOf(ref);
    const n = nodeHolding(sp.tiling, ref);
    if (!n) return;
    const r = C.toggleStacking(sp.tiling, n, sp.area || areaOf(homeOf.get(ref)));
    sp.tiling = r.root;
    // Dissolving puts each of the other members in a leaf of its own; every one of them is in
    // this space already, so only the decorations and the bar have to catch up.
    for (const m of C.preOrder(sp.tiling)) if (C.isMapped(m.data)) syncDecorations(m.data);
    if (!n.data.stacked) dropStackUi(n.data);
    for (const m of n.data.windows) forget(m);
    layoutOf(ref);
    ws.activeWindow = w;
}

// Not COSMIC's: upstream has only ToggleStacking, which dissolves a stack with the same key that
// made it. A separate dissolve is here because a toggle gives no way to say "take this apart"
// without first knowing whether it is together -- see keybindings.json, additions.
function dissolveStack() {
    const w = ws.activeWindow;
    if (!w || !attached(w)) return;
    const n = nodeFor(refOf(w));
    if (!n || !C.isStack(n.data)) return;
    toggleStack();
}
function cycleStack(step) {
    const w = ws.activeWindow;
    if (!w) return;
    const n = nodeFor(refOf(w));
    if (!n || !C.isStack(n.data) || n.data.windows.length < 2) return;
    batched(() => {
        const d = n.data;
        const next = (d.active + step % d.windows.length + d.windows.length) % d.windows.length;
        setActiveMember(d, next);
        layoutOf(d.ref);
    });
}

// ---------- orientation ----------
// ToggleOrientation :2109. The group around the selection turns, and the sizes come with it:
// update_geometry rescales the vector into the length the new axis has, so two children that
// were a third and two thirds across stay a third and two thirds down.
function toggleOrient() {
    const n = selectedNode();
    const g = n && (C.isGroup(n.data) ? n : n.parent);
    if (!g) return;
    g.data.orientation = g.data.orientation === C.VERTICAL ? C.HORIZONTAL : C.VERTICAL;
    const w = ws.activeWindow;
    layoutOf(refOf(w || cur));
    if (w) ws.activeWindow = w;
}

// ---------- modes ----------
//
// Resizing and SwapWindow. Both arm a mode: the chord that starts it changes what the direction
// keys mean until it is pressed again. Those direction keys are registered shortcuts here because
// a KWin script receives nothing it has not registered -- cosmic-comp handles them inside the
// compositor, so they appear in no keymap file; see modes.resize and modes.swap in
// keybindings.json.
//
// SwapWindow is modal for a reason that can be read off the keymap: the action carries no
// direction in keybindings.ron, yet swapping two windows needs one. Either it is modal or it
// takes its direction from somewhere that does not exist here; modal is the only coherent
// reading, and it is the shape COSMIC already uses for Resizing.
let mode = "";

// The arming chord toggles. Pressing Meta+R again, or Meta+X while swapping, is the way out --
// there is no Escape to bind, and a mode nothing can turn off is a trap.
//
// Keyboard auto-repeat reaches a global shortcut, and that is deliberate on KWin's side:
// GlobalShortcutFilter treats KeyboardKeyState::Repeated exactly like Pressed (input.cpp :1099),
// which is what makes a held arrow repeat a resize step. The arming chord is delivered the same
// way, so holding Meta+X toggled the mode at the keyboard's repeat rate -- and every toggle *off*
// ran doSwap. Reported as the mode flickering; it was also swapping.
//
// Upstream never meets this, because there the mode *is* the hold: SwapWindowGrab discards every
// release (grabs/swap.rs :49) and the mode ends when the chord comes up (input/mod.rs :2407). Here
// there is no key-up to hear and no repeat flag to read, so a repeat is recognised by its timing,
// using KWin's own numbers: RepeatDelay 600ms and RepeatRate 25/s (keyboard_input.cpp :200). The
// first repeat lands one delay after the press and the rest one gap apart, so an activation within
// ARM_DELAY of the last one is a repeat; swallowing one shortens the window to ARM_GAP, because the
// rest of the chain is fast. A chord held for a minute therefore arms once, and the mode can be
// toggled again a gap after the key comes up rather than a whole delay later.
//
// Per chord, not globally: a repeat chain can only come from the key that is down, so Meta+X
// followed quickly by Meta+R is two gestures and both are honoured.
//
// What it costs: the same chord pressed twice deliberately inside ARM_DELAY does nothing the second
// time. A mode is entered, used and left over seconds, so that window sits inside one gesture
// rather than across two.
const ARM_DELAY = 700;   // longer than RepeatDelay, which defaults to 600
const ARM_GAP = 250;     // longer than one gap at any usable rate; 25/s is 40ms
let armLast = "";
let armAt = 0;
let armRepeating = false;

function toggleMode(name) {
    const chord = name;
    const now = Date.now();
    if (chord === armLast && now - armAt < (armRepeating ? ARM_GAP : ARM_DELAY)) {
        armAt = now;
        armRepeating = true;
        return;
    }
    armLast = chord;
    armAt = now;
    armRepeating = false;
    if (mode === name) { exitMode(); return; }
    enterMode(name);
}

function enterMode(name) {
    const w = ws.activeWindow;
    if (!w || !attached(w)) return;
    mode = name;
    swapFrom = name === "swap" ? refOf(w) : null;
    resizeAmount = RESIZE_FROM;
    resizeLast = "";
    resizeAt = 0;
    ui.activeMode = name;
    // Name the keys. Nothing else does: the outline used to turn the accent colour while a mode held
    // the arrows, and dimming has no second colour to spend on it. The OSD is now the whole of what
    // says a mode is on, and the only thing that can say the arrows here still need their Meta,
    // which upstream's do not -- see modeOsd in main.qml.
    try { if (ui.modeOsd) ui.modeOsd(name); } catch (e) {}
    updateSelection();
}
export function exitMode() {
    if (!mode) return;
    const was = mode, from = swapFrom;
    mode = "";
    swapFrom = null;
    ui.activeMode = "";
    resizeAmount = RESIZE_FROM;
    resizeLast = "";
    resizeAt = 0;
    if (was === "swap") doSwap(from);
    updateSelection();
}

// The step accelerates, and it is upstream's: Shell::resize :4814 starts at 10, adds 2 on every
// repeat and stops at 20. It is kept across presses in `resize_state`, which finish_resize clears
// when the key comes *up* -- so a tap is 12 and holding the key walks up to 20.
//
// ACCEPTED DIVERGENCE in where it resets. A KWin script is delivered a shortcut activation and
// never a release, so there is no key-up to clear it on. It resets when the mode is armed and
// whenever the direction changes, which is the nearest thing to "a new gesture" that this side can
// see. Holding one arrow still accelerates; letting go and pressing the same arrow again does not
// start over, which upstream would.
const RESIZE_FROM = 10, RESIZE_BY = 2, RESIZE_TO = 20;
// Upstream repeats a held key through a 200ms timer (input/mod.rs :2510). Nothing throttles a KWin
// shortcut: holding an arrow delivers it at the keyboard's own repeat rate, which is five or six
// times that, and every one of them writes geometry and starts the animation again. That is what
// reads as the screen flickering.
const RESIZE_REPEAT = 200;
let resizeAmount = RESIZE_FROM;
let resizeLast = "";
let resizeAt = 0;
// What an arrow means, and the sentence the whole mode rests on: *the arrow names the size, not
// the edge*. Right widens, Left narrows, Down heightens, Up shortens -- on every window, wherever
// it sits in the tree. Which seam pays for it is the tree's business and not the user's.
//
// ACCEPTED DIVERGENCE, and the second half of collapsing Meta+Shift+R into Meta+R. Upstream is
// edge-shaped: the arrow says which way a boundary travels (ResizeEdge::flip_direction, shell/
// grabs/mod.rs :141) and the *mode* says whether that grows or shrinks. Two chords, so both are
// always reachable. With one chord an edge-shaped rule has to read the growing and the shrinking
// off the same four keys, and the only way to do that is from which side of the seam the window
// happens to be on -- which makes Right widen the leftmost window and narrow the rightmost one.
// That is wrong in the way that matters: the same key would do opposite things to two windows a
// user would call equivalent.
//
// So the direction is fixed and the edge is searched. The trailing seam is tried first -- right on
// the horizontal axis, bottom on the vertical -- and the leading one after it, and a seam that
// refuses is not the end of the gesture. The refusal that makes this worth doing is the minimum: a
// window only grows by taking from a neighbour, and a neighbour sitting on MIN_PANE has nothing to
// give. Asking the other side is a second chance at the same request, not a different request.
//
// What stays dead is a window with no seam on the axis at all -- one that spans the whole work
// area that way. There is nothing to redistribute there and no rule can invent it.
const AXIS = {
    left:  { edges: [C.EDGE_RIGHT, C.EDGE_LEFT], grow: false },
    right: { edges: [C.EDGE_RIGHT, C.EDGE_LEFT], grow: true },
    up:    { edges: [C.EDGE_BOTTOM, C.EDGE_TOP], grow: false },
    down:  { edges: [C.EDGE_BOTTOM, C.EDGE_TOP], grow: true },
};
const DIR_OF = { left: C.LEFT, right: C.RIGHT, up: C.UP, down: C.DOWN };

function resizeStep(dir) {
    const w = ws.activeWindow;
    if (!w) return;
    const sp = spaceOf(refOf(w));
    const n = selectedNode();
    if (!sp || !n) return;
    const now = Date.now();
    if (dir !== resizeLast) { resizeAmount = RESIZE_FROM; resizeLast = dir; }
    else if (now - resizeAt < RESIZE_REPEAT) return;
    resizeAt = now;
    resizeAmount = Math.min(resizeAmount + RESIZE_BY, RESIZE_TO);
    // Trailing seam first, leading seam second, same request both times. A refusal costs nothing to
    // retry: C.resize writes nothing when it refuses -- both minimum guards return before touching
    // the vector, and an exhausted pane takes zero -- so the second attempt starts from exactly the
    // state the first one found. The refusal that makes this worth doing is the minimum: a window
    // only grows by taking from a neighbour, and a neighbour sitting on MIN_PANE has nothing to
    // give. Without the second attempt that is the whole of the arrow, which is how the dead key
    // was reported.
    const axis = AXIS[dir];
    const towards = axis.grow ? C.OUTWARDS : C.INWARDS;
    for (const edge of axis.edges) {
        const r = C.resize(sp.tiling, n, towards, edge, resizeAmount);
        if (!r.changed) continue;
        layoutOf(refOf(w));
        return;
    }
}

// SwapWindow marks a window, lets the focus go wherever it likes, and trades the two when the mode
// ends. That is upstream, not an adaptation: SwapWindowGrab (grabs/swap.rs) looks up the user's own
// Focus bindings and dispatches Action::Focus(direction) for whichever one was pressed, and
// keyboard_swap (input/mod.rs :2420) runs on release, between the node that was marked and
// whatever is focused by then -- across workspaces, if the focus went that far.
//
// Swapping with the geometric neighbour on every arrow is the obvious reading and the wrong one: a
// second press only trades the two back, because there is nowhere else it can go.
let swapFrom = null;

function doSwap(fromRef) {
    const w = ws.activeWindow;
    if (!fromRef || !w) return;
    const toRef = refOf(w);
    if (toRef === fromRef) return;
    const keyA = homeOf.get(fromRef), keyB = homeOf.get(toRef);
    if (keyA === undefined || keyB === undefined) return;
    const spA = spaces.get(keyA), spB = spaces.get(keyB);
    if (!spA || !spB) return;
    const a = nodeHolding(spA.tiling, fromRef), b = nodeHolding(spB.tiling, toRef);
    if (!a || !b || a === b) return;

    const t = a.data; a.data = b.data; b.data = t;
    // The windows went with the data, so homeOf has to go with them. Across two spaces this is the
    // only thing that moves them; the nodes never left their own tree.
    for (const ref of a.data.windows) homeOf.set(ref, keyA);
    for (const ref of b.data.windows) homeOf.set(ref, keyB);
    for (const ref of a.data.windows.concat(b.data.windows)) forget(ref);
    layout(keyA);
    if (keyB !== keyA) layout(keyB);
    // Focus stays on the window that was marked, now wherever it ended up -- upstream keeps the
    // keyboard on the swapped node (focus/mod.rs :853).
    const back = winOf(fromRef);
    if (back) ws.activeWindow = back;
}

// ---------- keyboard movement ----------
//
// Move(dir) :1507. The window is rearranged inside the tree first, and only once it has reached
// the edge of that tree does it leave for the neighbouring workspace (MoveResult::MoveFurther).
// Workspaces here are a horizontal strip, so only left and right continue past the edge; up and
// down stop, where COSMIC would fall back to MoveToOutput.
function moveWindow(dir) {
    const w = ws.activeWindow;
    if (!w) return;
    const ref = refOf(w);
    const sp = spaceOf(ref);
    const group = !!liveSelection();
    const n = sp ? selectedNode() : null;
    if (n) {
        const r = C.moveCurrentNode(sp.tiling, n, DIR_OF[dir]);
        sp.tiling = r.root;
        if (r.result === C.MOVE_DONE) {
            // A window pushed out of a stack, or into one, lands in a leaf that is not the one it
            // was in; the ref map has to follow it before anything is measured.
            syncRefs(sp, homeOf.get(ref));
            layoutOf(ref);
            // shift_focus is upstream's, and it is not always the window that moved: a window
            // pushed into a stack leaves whichever member was in front still in front, and the
            // focus goes to the stack. Overriding it here would bring the newcomer forward and
            // quietly change what the key does.
            const to = r.shiftFocus ? winOf(r.shiftFocus.data.ref) : winOf(ref);
            if (to) ws.activeWindow = to;
            return;
        }
        if (r.result === C.MOVE_NONE) return;
        // MoveFurther hands the node to the next output upstream. KOSMIC has no per-output
        // workspaces, so the fallback below is the neighbouring workspace -- and that is a move
        // for a window, not for a group. Handing one window of a selected group to another
        // workspace is not the move that was asked for, and with the selection invisible it reads
        // as the arrow keys having started to throw windows away.
        if (group) return;
    }
    if (dir === "left") moveToWorkspace(-1, C.LEFT);
    else if (dir === "right") moveToWorkspace(1, C.RIGHT);
}

// Every window the tree holds belongs to this space, and the decorations follow whether its leaf
// is a stack. Cheap enough to run after any move that can change either.
function syncRefs(sp, key) {
    if (!sp || !sp.tiling) return;
    for (const n of C.preOrder(sp.tiling)) {
        if (!C.isMapped(n.data)) continue;
        syncDecorations(n.data);
        for (const ref of n.data.windows) if (homeOf.get(ref) !== key) homeOf.set(ref, key);
    }
}

// ---------- actions ----------
export function action(name) { batched(() => runAction(name)); }

// What a mode changes is what the arrow keys *mean*, not which keys are bound.
//
// Registering a second set of shortcuts carrying the same chords, with a sequence only while their
// mode is active, cannot work, for the reason the rest of this is designed against:
// kglobalshortcutsrc is authoritative once it exists, and
// those entries are written there as `none` precisely because they must not hold a chord when the
// mode is off. A QML `sequence` is only the default used when the file has no entry, so the keys
// stayed unbound in every mode and Meta+R did nothing at all. Escape proved it -- it collides with
// no other shortcut, and it was still empty with the mode armed.
//
// So the arrows stay permanently bound to Focus, and a mode reinterprets them here. One
// registration per chord, which is the only shape kglobalaccel allows.
function runAction(name) {
    const m = /^(focus|window)-(left|right|up|down)$/.exec(name);
    if (m) {
        if (m[1] === "window") { exitMode(); return moveWindow(m[2]); }
        if (mode === "resize") return resizeStep(m[2]);
        // Swap navigates with the very same Focus action; the trade happens when the mode ends.
        return focusDir(m[2]);
    }
    switch (name) {
        case "dump": return dump();
        // Everything else leaves the mode before it runs. A mode that outlives the keys it was
        // armed for is a mode the user cannot see and did not ask for.
        case "focus-in": exitMode(); return focusIn();
        case "focus-out": exitMode(); return focusOut();
        // The arming chord is a toggle: it is the only key that can turn the mode off, because
        // Escape cannot be bound without taking Escape away from everything else on the desktop.
        case "resize": return toggleMode("resize");
        case "swap-window": return toggleMode("swap");
        // The same mode, driven from outside as the two halves of a held chord. See
        // kosmic-chordhold: the plugin sees the release that a KWin
        // script never will, and calls these by name on the trigger's begin and end.
        //
        // Neither goes through toggleMode and neither wants its repeat guard. That guard exists
        // because auto-repeat reaches a global shortcut, and the plugin blocks the key it is
        // triggered by, so KWin sees no repeats at all while it is loaded. Both are idempotent,
        // which is what makes them safe to call from a trigger whose begin and end are not
        // guaranteed to be paired: arming twice is armed, committing nothing is nothing.
        case "swap-arm": if (mode !== "swap") enterMode("swap"); return;
        case "swap-commit": if (mode === "swap") exitMode(); return;
        // And the same pair for the resize, which owes nothing on the way out: by the time the
        // chord opens, every step it asked for has already been laid out.
        case "resize-arm": if (mode !== "resize") enterMode("resize"); return;
        case "resize-release": if (mode === "resize") exitMode(); return;
        case "workspace-left": exitMode(); return moveToWorkspace(-1, C.LEFT);
        case "workspace-right": exitMode(); return moveToWorkspace(1, C.RIGHT);
        // Switching workspaces is this module's and not KDE's, because stepping past the last one
        // has to *create* one. It was a KWin script of its own until the two were merged; see
        // "the workspace list".
        case "workspace-next": exitMode(); return goWorkspace(1);
        case "workspace-prev": exitMode(); return goWorkspace(-1);
        // By position and not by step. KWin has no action for the last desktop -- only "Switch to
        // Desktop N" for a fixed N -- and with the workspace list changing under it, which number
        // the last one has is exactly what a key cannot know.
        case "workspace-last": exitMode(); return goLastWorkspace();
        case "workspace-move-last": exitMode(); return moveToLastWorkspace();
        case "orientation": exitMode(); return toggleOrient();
        case "floating": exitMode(); return toggleFloating();
        case "tiling": exitMode(); return toggleTiling();
        // Set, not toggled, and reached only by name: the applet invokes one of these through
        // kglobalaccel after writing the kwinrc key, because a script reads its configuration when
        // it loads and `reconfigure` does not reach it. The write is what survives the session;
        // this is what makes the choice apply to the next workspace created in this one.
        case "new-workspace-tiled": NEW_WORKSPACE_TILED = true; return publishTiling(false);
        case "new-workspace-floating": NEW_WORKSPACE_TILED = false; return publishTiling(false);
        // Reached only by name, like the two above, and the applet calls it immediately before
        // reading the value back. That ordering is the whole liveness check: what answers is a
        // reading this script just produced, and if the script is not running nothing refreshes
        // it and the applet is told so rather than shown a stale guess. See state/.
        case "publish-state": return publishTiling(true);
        // Also by name only. The applet writes a gap into kwinrc, sends `org.kde.KWin.reconfigure`
        // so KWin drops the copy it is holding, and then calls this -- see reloadSettings().
        case "reload-settings": return reloadSettings();
        case "stack": exitMode(); return toggleStack();
        case "stack-dissolve": exitMode(); return dissolveStack();
        case "stack-next": exitMode(); return cycleStack(1);
        case "stack-prev": exitMode(); return cycleStack(-1);
    }
    log("no handler for action " + name);
}

// ---------- move to workspace ----------
//
// The window leaves its space (the others fill the gap), enters the target one at the edge it
// came from, and the view follows it. A new workspace is created past the edge only if the window
// is not alone on its own -- otherwise walking right would mint a workspace per keypress.
function desktopIndex(d) {
    if (!d) return -1;
    const ds = ws.desktops;
    for (let i = 0; i < ds.length; i++) if (ds[i].id === d.id) return i;
    return -1;
}
function moveToWorkspace(step, dir) {
    const w = ws.activeWindow;
    if (!w || !w.normalWindow || w.desktops.length !== 1) return;
    const from = w.desktops[0];
    let i = desktopIndex(from);
    let j = i + step;
    if (j < 0 || j >= ws.desktops.length) {
        // The same question the workspace policy asks, asked once. This used to be a second copy
        // of occupied() with the answer inverted, in a file that could not see the first -- which
        // is the duplication that merging the two scripts was for.
        if (!occupied(w).has(from.id)) return;
        ws.createDesktop(step > 0 ? ws.desktops.length : 0, "Desktop");
        i = desktopIndex(from);
        j = i + step;
        if (ws.desktops[j]) ws.currentDesktop = ws.desktops[j];   // the current desktop is never auto-removed
    }
    const target = ws.desktops[j];
    if (!target) return;
    sendToDesktop(w, target, dir);
}

// The last workspace in the list, which is the empty one the policy keeps at the end when
// dynamic workspaces are on. Moving a window there is the same hand-over as moving it to a
// neighbour, entering from the edge opposite the way it travelled.
function moveToLastWorkspace() {
    const w = ws.activeWindow;
    if (!w || !w.normalWindow || w.desktops.length !== 1) return;
    const target = ws.desktops[ws.desktops.length - 1];
    if (!target || target.id === w.desktops[0].id) return;
    sendToDesktop(w, target, C.RIGHT);
}
function goLastWorkspace() {
    const last = ws.desktops[ws.desktops.length - 1];
    if (last) ws.currentDesktop = last;
}
function sendToDesktop(w, target, dir) {
    const tiled = attached(w);
    const oldKey = homeOf.get(refOf(w));
    if (tiled) unmapWindow(w);
    w.desktops = [target];
    forget(refOf(w));
    // map_to_tree with a direction :570: a window that crosses into a workspace does not land
    // beside one of its windows but beside the whole tree, on the edge opposite the way it went.
    if (tiled || shouldTile(w)) mapWindow(w, dir);
    if (oldKey) layout(oldKey);
    ws.currentDesktop = target;
    ws.activeWindow = w;
}

// ---------- the workspace list ----------
//
// This was `kosmic-workspaces`, a plain `javascript` KWin script of its own, until it was folded
// in here. Its own header already argued for the move: COSMIC keeps the workspace lifecycle in the
// same crate as the tiling (`cosmic-comp` src/shell/), the tiler creates workspaces in
// moveToWorkspace and reasons about what the policy removes, and two files that cannot see each
// other is how one rule gets written twice. It was written twice -- the `alone` test above is
// `occupied()` with the answer inverted -- and worse, both scripts connected `windowAdded` and
// `windowRemoved` with no order defined between them, so a workspace could be removed while the
// tiler was laying its space out. Nothing in a KWin script can even observe that race, which is
// the kind of bug that gets attributed to KWin.
//
// It also had no test. A separate `javascript` package cannot be imported by the simulator, which
// loads the tiler as an ES module; here it runs under the same harness as everything else.
//
// Provenance: this came in under MIT from an unrecorded source and the licence travelled with the
// file. It is GPL-3.0 now, as part of this one, and the notice stays here for that reason.
let DYNAMIC_WORKSPACES = true;

// Guards the two calls that change the desktop list against being re-entered by the signals they
// raise. Removing a desktop is not a window event, but `currentDesktopChanged` lands in the
// tiler's own handler, which lays every space out again.
let listBusy = false;

// A window that holds a workspace open. `skipPager` is how a desktop widget or a panel says it is
// not one of these, and `onAllDesktops` means it holds none of them in particular.
//
// A minimized window holds nothing: a workspace with only minimized windows is an empty one and is
// collected when left, and KWin moves what was on it to a workspace that remains. This is what the
// user asked for; upstream agrees, since its Workspace::windows() leaves out the minimized ones.
function holdsWorkspace(w, ignored) {
    return w !== ignored && w.normalWindow && !w.skipPager && !w.onAllDesktops && !w.minimized;
}
function occupied(ignored) {
    const set = new Set();
    for (const w of allWindows()) {
        if (!holdsWorkspace(w, ignored)) continue;
        for (const d of w.desktops) set.add(d.id);
    }
    return set;
}

// A space is keyed by (output, desktop); a desktop that is gone leaves one that can never be
// reached and never be collected, because the collection in layout() now keeps an empty space
// whose tiling flag differs from the default. Pruning here is the half of that which only this
// code can do -- it is the only thing that knows a desktop was removed.
function dropDeadSpaces() {
    const live = new Set(ws.desktops.map((d) => d.id));
    for (const key of Array.from(spaces.keys())) {
        const at = key.lastIndexOf("|");
        if (at > 0 && !live.has(key.slice(at + 1))) spaces.delete(key);
    }
}

// Which empty workspaces survive: only the active one. The trailing empty workspace upstream keeps
// is not kept here -- it is made when the user walks off the last occupied workspace, shown while
// they stand on it, and collected as soon as they leave it, like any other empty one.
//
// Upstream's rule (Workspaces::ensure_last_empty, cosmic-comp src/shell/mod.rs) keeps the trailing
// one so that it is always there to walk into; the panel here only draws workspaces that hold
// something, so a permanent ghost showed as an empty square.
function ensureLastEmpty(ignored) {
    if (!DYNAMIC_WORKSPACES || listBusy) return;
    listBusy = true;
    try {
        const used = occupied(ignored);
        const ds = ws.desktops;
        const active = desktopIndex(ws.currentDesktop);
        for (let i = ds.length - 1; i >= 0; i--) {
            if (used.has(ds[i].id) || i === active) continue;
            if (ws.desktops.length > 1) ws.removeDesktop(ds[i]);
        }
        dropDeadSpaces();
    } finally {
        listBusy = false;
    }
}

// Neighbour in direction dir (+1/-1), creating a ghost workspace at the edge only when the current
// one is occupied.
function neighbourDesktop(dir, create) {
    const ds = ws.desktops;
    const i = desktopIndex(ws.currentDesktop);
    const j = i + dir;
    if (j >= 0 && j < ds.length) return ds[j];
    if (!create) return null;
    listBusy = true;
    try {
        ws.createDesktop(dir > 0 ? ds.length : 0, "Desktop");
    } finally { listBusy = false; }
    return ws.desktops[dir > 0 ? ws.desktops.length - 1 : 0];
}

// Cleanup runs here, before the switch, and never after one. KWin's slide effect fixes the two ends
// of its animation once, when the desktop changes (slide.cpp :381), but re-reads the desktop grid
// on every frame it paints (slide.cpp :269). A workspace removed while a slide is in flight
// collapses the grid under it: `wrappingX = drawPosition.x() > gridWidth - 1` turns true and a
// whole screen width is added to the translation, so the window arrives from the wrong side instead
// of sliding in from the one it came from. Removing before the switch leaves the grid fixed for the
// whole animation.
//
// The workspace left behind is therefore collected afterwards, by sweepTimer, once the slide is
// over: an empty workspace disappears from the list as soon as it is left, not one switch later.
function goWorkspace(dir) {
    // With the policy off these keys still step through the desktops KDE has; they simply stop
    // minting and collecting them. Leaving them unbound instead would hand the chord back to
    // nothing, since the module takes the KDE defaults that collide with it.
    if (!DYNAMIC_WORKSPACES) {
        const d = neighbourDesktop(dir, false);
        if (d) ws.currentDesktop = d;
        return;
    }
    ensureLastEmpty(null);
    const ds = ws.desktops;
    const here = ws.currentDesktop;
    const i = desktopIndex(here);
    if (i < 0) return;
    const edge = (dir > 0 && i === ds.length - 1) || (dir < 0 && i === 0);
    if (edge && !occupied(null).has(here.id)) return;   // already the empty ghost
    const d = neighbourDesktop(dir, true);
    if (d) ws.currentDesktop = d;
}

// ---------- dragging ----------
//
// cosmic-comp does not draw where a window would land: it replaces the dragged window with a
// placeholder (PlaceholderType::GrabbedWindow) and, once the pointer has settled, opens a second
// one (TargetZone::DropZone) where the window would go, laying the tree out for real so the
// neighbours move as you go. That is what happens here. Two things are KWin's and not COSMIC's:
// the dragged window belongs to the cursor and is never written to, and the drop zone is outlined
// as well as opened, because a placeholder on the live layout is an empty rectangle and an empty
// rectangle on a desktop does not read as "the window goes here".
let pending = null;      // a zone waiting out its dwell time
let previewed = null;    // the rect the outline is currently drawn at

function showPreview(r) {
    const key = rectKey(r);
    if (key === previewed) return;
    previewed = key;
    if (DEBUG) log("zone rect " + key);
    const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.width), h = Math.round(r.height);
    try {
        if (ui && ui.showZone && ui.showZone(x, y, w, h)) return;
        ws.showOutline(Qt.rect(x, y, w, h));   // KWin's own, if the drawn square could not be made
    } catch (e) { log("zone: " + e); }
}
function hidePreview() {
    if (previewed === null) return;
    previewed = null;
    try { if (ui && ui.hideZone) ui.hideZone(); } catch (e) {}
    try { ws.hideOutline(); } catch (e) {}
}
// The outline follows whatever the tree is currently holding open for the window: the drop zone
// once there is one, its own placeholder before that, and the target's slot when the window would
// join a stack (a stack opens no space, so there is nothing else to point at).
function showDragPreview() {
    if (!grab || grab.resizing || !DROP_PREVIEW) return;
    if (grab.stackTarget) {
        const d = grab.stackTarget.data;
        const g = toRect(d.geo);
        showPreview(d.stacked ? g : { x: g.x, y: g.y + barH, width: g.width, height: g.height - barH });
        return;
    }
    const n = grab.dropNode || grab.phNode;
    if (n) showPreview(slotRect(n));
}

// The rect a placeholder's window will actually be given. measure() insets mapped nodes by the
// gaps and leaves placeholders on the raw division (:2998), because upstream draws them itself in
// the overview and never has to line one up against a real window. Here the placeholder IS the
// preview, so it is drawn where the window lands rather than where the division fell.
// The rectangle a node's content actually occupies. A leaf's geometry already has the gaps taken
// out of it; a group's is the raw division (measure :2998 insets only mapped nodes), so the same
// insets have to be applied before the two can be framed the same way. Without this a group is
// framed an inner gap outside the screen.
function contentRect(n) {
    const g = n.data.geo;
    if (!C.isGroup(n.data)) return { x: g.x, y: g.y, width: g.w, height: g.h };
    return slotRect(n);
}

// What the marker actually covers. Upstream hands the indicator the node's own rect straight off
// the tree (tiling/mod.rs :5481) and there is no third possibility there: a cosmic-comp client is
// the size the compositor says it is.
//
// ACCEPTED DIVERGENCE from cosmic-comp. A KWin client can refuse, and one that refuses is
// drawn outside the slot it was given -- over its neighbour, in the case that showed this -- so the
// slot alone leaves half of the selected window outside the marker, and the effect dims the window
// the user is looking at. The rect is
// the union of the slot and what the window actually took: the slot whenever the client complied,
// which is every ordinary case and every case upstream has, and the slot is still what a resize or
// a move acts on. The union only adds "and it spilled to here".
function selectionRect(n) {
    const r = contentRect(n);
    if (C.isGroup(n.data)) return r;
    const d = n.data;
    const ref = d.windows && d.windows.length ? d.windows[d.active] : d.ref;
    const w = winOf(ref);
    if (!w || w.minimized) return r;
    const f = fg(w);
    // Only a window standing in its own slot may enlarge it. One that is somewhere else entirely
    // -- on another output, restored from a maximize, mid-handover -- would drag the marker across
    // the screen, and a marker that lies about where the selection is costs more than one that is
    // merely too small.
    if (f.x >= r.x + r.width || r.x >= f.x + f.width ||
        f.y >= r.y + r.height || r.y >= f.y + f.height) return r;
    const x = Math.min(r.x, f.x), y = Math.min(r.y, f.y);
    return {
        x: x, y: y,
        width: Math.max(r.x + r.width, f.x + f.width) - x,
        height: Math.max(r.y + r.height, f.y + f.height) - y,
    };
}

function slotRect(n) {
    const g = n.data.geo;
    const l = C.hasAdjacentNode(n, C.LEFT) ? C.idiv(inner, 2) : inner;
    const t = C.hasAdjacentNode(n, C.UP) ? C.idiv(inner, 2) : inner;
    const r = C.hasAdjacentNode(n, C.RIGHT) ? C.idiv(inner, 2) : inner;
    const b = C.hasAdjacentNode(n, C.DOWN) ? C.idiv(inner, 2) : inner;
    return { x: g.x + l, y: g.y + t, width: g.w - l - r, height: g.h - t - b };
}

function startDrag(w) {
    const ref = refOf(w);
    const sp = spaceOf(ref);
    grab.key = homeOf.get(ref);
    if (!DROP_PREVIEW || !sp || !sp.tiling) return;
    const n = nodeHolding(sp.tiling, ref);
    if (!n) return;
    const d = n.data;
    if (d.windows.length > 1) {
        // A tab dragged off a stack leaves it there and then: the stack has its own slot and the
        // window no longer has a claim on it. COSMIC does the same with a tab torn out.
        const i = d.windows.indexOf(ref);
        d.windows.splice(i, 1);
        C.stackSetActive(d, i === d.windows.length ? i - 1 : d.active > i ? d.active - 1 : d.active);
        setStacked(ref, false);
        grab.data = C.newMapped(ref, C.copyGeo(d.geo));
        grab.zone = null;
        layout(grab.key);
        return;
    }
    grab.data = d;
    grab.phNode = n;
    n.data = C.newPlaceholder(++phSeq, C.GRABBED_WINDOW, C.copyGeo(d.geo));
    grab.zone = { kind: C.ZONE_INITIAL_PLACEHOLDER, node: n };
    dropStackUi(d);
    layout(grab.key);
}

function previewDrag(w) {
    if (!DROP_PREVIEW || !grab || grab.w !== w || grab.resizing) return;
    // startDrag only fills in `data` when it found the window in a tree. Without it there is
    // nothing to put back on release, and opening a drop zone for a window that has none is how a
    // node ends up in the tree carrying no data at all -- which then takes the next walk of that
    // tree down with it, and the walk is reconcile.
    if (!grab.data) return;
    const sp = spaces.get(grab.key);
    if (!sp) return;
    const cp = ws.cursorPos;
    // ACCEPTED DIVERGENCE, and it is a loop that has to be cut rather than a preference.
    //
    // Committing a zone changes the frame the next one is measured in: once a group holds a drop
    // zone the walk stops there (:3386) and the thirds are taken across the whole group instead of
    // across the window under the pointer. So a split committed near the middle of a two-window
    // layout reads back as a stack, which takes the drop zone away again, which reads back as a
    // split -- a pointer that never moves makes the layout flicker between the two. Upstream does
    // not meet this because a COSMIC drag happens in the workspace overview, where a group is drawn
    // with padding around its children and the two frames are not the same rectangle.
    //
    // So the layout does not reconsider until the pointer has travelled. EDGE_BAND is upstream's
    // own figure for how far a pointer has to move to mean something, and reusing it keeps one
    // number rather than inventing a second.
    if (grab.committedAt) {
        const dx = cp.x - grab.committedAt.x, dy = cp.y - grab.committedAt.y;
        if (Math.hypot(dx, dy) < C.EDGE_BAND) { pending = null; return; }
    }
    const z = C.zoneAt(sp.tiling, { x: cp.x, y: cp.y }, grab.zone);
    if (C.zonesEqual(z, grab.zone)) { pending = null; return; }
    if (C.zonesEqual(z, pending)) return;             // already waiting on this one
    if (DEBUG) log("zone " + z.kind);
    pending = z;
    if (ui && ui.dragTimer) {
        // Leaving the dragged window's own placeholder is slower than any other move, so a drag
        // that starts by twitching does not immediately tear the layout apart.
        ui.dragTimer.interval = (grab.zone && grab.zone.kind === C.ZONE_INITIAL_PLACEHOLDER)
            ? C.INITIAL_MOUSE_ANIMATION_DELAY : C.MOUSE_ANIMATION_DELAY;
        ui.dragTimer.restart();
    } else {
        commitZone();                                 // no timer to wait on: take it immediately
    }
}

// Called by the dwell timer: the pointer stayed in one zone long enough to mean it.
export function dragCommit() { batched(commitZone); }
function commitZone() {
    let z = pending;
    pending = null;
    if (!z || !grab || grab.resizing || !grab.data) return;
    const sp = spaces.get(grab.key);
    if (!sp) return;

    if (grab.dropNode) { sp.tiling = C.unmapInternal(sp.tiling, grab.dropNode); grab.dropNode = null; }
    grab.stackTarget = null;

    // The zone is read again here, after the previous drop zone has been taken out, and it is the
    // one that gets applied. The one the dwell timer was waiting on was computed against a tree
    // that has since changed: removing a drop zone dissolves the group that held it whenever that
    // group is down to two children, and `z.node` then names a group that is no longer in the
    // tree. drop_window happily adds a size to it and inserts the placeholder into it, which is a
    // group with three sizes and one child sitting off to the side of the layout -- measure() then
    // hands out a rect meant for a child that does not exist and strands the rest, and the windows
    // that land there are in no tree at all.
    //
    // What the dwell decided is *that the user means it*, not *what* they meant; where they meant
    // it has to come from the tree as it stands at the moment of application. The preview is drawn
    // from the result below, so what is shown still cannot drift from what happened.
    const cp = ws.cursorPos;
    z = C.zoneAt(sp.tiling, { x: cp.x, y: cp.y }, grab.zone);

    if (z.kind === C.ZONE_INITIAL_PLACEHOLDER) {
        grab.zone = z;
        grab.committedAt = { x: ws.cursorPos.x, y: ws.cursorPos.y };
        layout(grab.key);
        return;
    }
    if (z.kind === C.ZONE_WINDOW_STACK) {
        grab.stackTarget = z.node;
    } else {
        const ph = C.node(C.newPlaceholder(++phSeq, C.DROP_ZONE, C.copyGeo(C.INITIAL_GEO)));
        const r = C.dropWindow(sp.tiling, ph, z, sp.area);
        sp.tiling = r.root;
        grab.dropNode = ph;
    }
    // The window has committed to somewhere that is not its own slot, so it gives that slot up
    // and the neighbours close over it -- upstream unmaps the InitialPlaceholder at exactly this
    // point. There is no way back to it afterwards, which is upstream's behaviour too.
    if (grab.phNode) { sp.tiling = C.unmapInternal(sp.tiling, grab.phNode); grab.phNode = null; }
    grab.zone = z;
    grab.committedAt = { x: ws.cursorPos.x, y: ws.cursorPos.y };
    layout(grab.key);
}

// Letting go. The placeholder the layout has been holding open is simply handed the window's own
// data, which is the InitialPlaceholder arm of drop_window :2666 -- the window lands exactly
// where the preview said it would because it is the same node.
function finishDrag(g) {
    const sp = spaces.get(g.key);
    const ref = refOf(g.w);
    if (!sp) { if (shouldTile(g.w)) mapWindow(g.w, null); return; }

    if (g.stackTarget) {
        const d = g.stackTarget.data;
        C.convertToStack(d);
        C.stackAdd(d, g.data.windows, null);
        C.stackSetActive(d, d.windows.indexOf(ref));
        syncDecorations(d);
        for (const m of d.windows) forget(m);
    } else if (g.dropNode && g.data) {
        const geo = g.dropNode.data.geo;
        g.dropNode.data = g.data;
        g.dropNode.data.geo = geo;
    } else if (g.phNode && g.data) {
        g.phNode.data = g.data;
    } else if (g.data) {
        sp.tiling = C.mapToTree(sp.tiling, C.node(g.data), null, null, sp.area);
    } else {
        // Placeholders with nothing to become. Leaving one in the tree is a slot that is measured
        // and never written into, so they come out before the window is mapped the ordinary way.
        if (g.dropNode) sp.tiling = C.unmapInternal(sp.tiling, g.dropNode);
        if (g.phNode) sp.tiling = C.unmapInternal(sp.tiling, g.phNode);
        layout(g.key);
        if (shouldTile(g.w)) mapWindow(g.w, null);
        return;
    }
    homeOf.set(ref, g.key);
    forget(ref);
    layout(g.key);
    // KWin may have carried the window onto another output or desktop during the drag; the signals
    // for that are ignored while a grab is in progress, so the move is settled here instead.
    if (keyOf(g.w) !== g.key) {
        unmapWindow(g.w);
        if (shouldTile(g.w)) mapWindow(g.w, null);
        layout(g.key);
    }
}

// An interactive resize moves one seam of the layout. Which seam is resize_request :2477 -- the
// nearest ancestor group that runs along the edge being dragged -- and how far is simply how far
// that edge went.
function applyResize(g) {
    const sp = spaces.get(g.key);
    const n = sp ? nodeHolding(sp.tiling, refOf(g.w)) : null;
    if (!n) return;
    const a = sp.area;
    const r = fg(g.w);
    r.x = Math.max(a.x, r.x); r.y = Math.max(a.y, r.y);
    if (r.x + r.width > a.x + a.w) r.width = a.x + a.w - r.x;
    if (r.y + r.height > a.y + a.h) r.height = a.y + a.h - r.y;
    const o = g.rect;
    moveSeam(n, C.EDGE_LEFT, r.x - o.x);
    moveSeam(n, C.EDGE_RIGHT, (r.x + r.width) - (o.x + o.width));
    moveSeam(n, C.EDGE_TOP, r.y - o.y);
    moveSeam(n, C.EDGE_BOTTOM, (r.y + r.height) - (o.y + o.height));
    layout(g.key);
}
function moveSeam(n, edge, delta) {
    const d = Math.round(delta);
    if (Math.abs(d) < 2) return;
    const req = C.resizeRequest(n, edge);
    if (!req) return;
    const sizes = req.group.data.sizes;
    const i = req.idx, j = i + 1;
    if (j >= sizes.length) return;
    // The seam is between i and i+1 whichever edge was dragged, and the window being resized is on
    // one side or the other of it; moving the seam by d is the same arithmetic either way.
    const lo = sizes[i] + d, hi = sizes[j] - d;
    const floor = C.MIN_PANE[req.orientation];
    if (lo < floor || hi < floor) return;
    sizes[i] = lo; sizes[j] = hi;
}

function grabStarted(w) {
    if (grab && grab.w === w) return;
    // A grab already in flight for a *different* window is finished rather than overwritten.
    // Dropping it leaves its placeholder standing in the tree with nothing left that knows about
    // it, and both ends of a drag are heard on two signals apiece, so the two can interleave.
    if (grab) { try { grabFinished(grab.w); } catch (e) { log("grab handover: " + e); } }
    hidePreview();
    manual = true;
    pending = null;
    grab = { w, rect: fg(w), resizing: !!w.resize, key: null, data: null, phNode: null, dropNode: null, stackTarget: null, zone: null, committedAt: null };
    if (!grab.resizing && attached(w)) startDrag(w);
    else grab.key = homeOf.get(refOf(w));
}
function grabFinished(w) {
    const g = grab;
    if (!g || g.w !== w) { if (!g) manual = false; hidePreview(); return; }
    try {
        // The zone the pointer is in but has not dwelled in long enough yet still counts: the
        // dwell is there to stop the layout thrashing on the way somewhere, not to make a quick
        // drag do nothing. And a drag that reported no steps at all -- a flick, or a compositor
        // that sends only the two ends -- is read off the cursor here, which is safe exactly
        // because nothing was committed: the tree is still the one the drag started from.
        if (!g.resizing && !pending && !g.dropNode && !g.stackTarget) {
            const sp = spaces.get(g.key);
            const cp = ws.cursorPos;
            if (sp) pending = C.zoneAt(sp.tiling, { x: cp.x, y: cp.y }, g.zone);
        }
        if (!g.resizing && pending) commitZone();
        grab = null;
        batched(() => { if (g.resizing) applyResize(g); else finishDrag(g); });
    } catch (e) {
        log("drop failed: " + e + " @ " + (e && e.stack));
    } finally {
        grab = null;
        pending = null;
        manual = false;   // whatever happened above, the tiler goes back to correcting the layout
        hidePreview();
    }
}
// KWin is the authority on whether a drag is in progress; the flag is only a cache of it.
function grabbedNow() {
    for (const w of allWindows()) { try { if (w.move || w.resize) return true; } catch (e) {} }
    return false;
}

// ---------- window events ----------
function connectWindow(w) {
    const ref = refOf(w);
    if (connected.has(ref)) return;
    connected.add(ref);
    windowOf.set(ref, w);

    w.frameGeometryChanged.connect(() => {
        if (w === ws.activeWindow) updateSelection();
        // A window that resized itself makes its space be laid out again.
        if (!manual && attached(w)) {
            const a = applied.get(ref), g = fg(w);
            if (!a || Math.abs(g.x - a.x) > 2 || Math.abs(g.y - a.y) > 2 ||
                g.width > a.width + 2 || g.height > a.height + 2) enforceSoon();
        }
    });
    if (w.captionChanged && w.captionChanged.connect) {
        w.captionChanged.connect(() => { const n = nodeFor(ref); if (n && n.data.stacked) syncBars(); });
    }
    for (const sig of ["maximizedChanged", "maximizedHorizontallyChanged", "maximizedVerticallyChanged"]) {
        if (w[sig] && w[sig].connect) w[sig].connect(() => onMaximizeChanged(w));
    }
    w.minimizedChanged.connect(() => batched(() => {
        if (w.minimized) {
            if (attached(w)) { rememberSibling(w); unmapWindow(w); forget(ref); }
        } else if (shouldTile(w) && !attached(w)) {
            restoreSlot(w);
        }
        try { ensureLastEmpty(null); } catch (e) { log("workspace list error: " + e); }
    }));
    w.fullScreenChanged.connect(() => batched(() => {
        if (w.fullScreen) { if (attached(w)) { unmapWindow(w); forget(ref); } }
        else if (shouldTile(w) && !attached(w)) mapWindow(w, null);
    }));
    // A window carried onto another output or desktop is remapped there. Not while it is being
    // dragged: KWin reports the new desktop as the pointer crosses, and finishDrag settles it once.
    const moved = () => {
        if (grab && grab.w === w) return;
        if (!attached(w) || homeOf.get(ref) === keyOf(w)) return;
        batched(() => { unmapWindow(w); forget(ref); if (shouldTile(w)) mapWindow(w, null); });
    };
    w.desktopsChanged.connect(moved);
    if (w.outputChanged) w.outputChanged.connect(moved);
    // Both ways of hearing about a drag are used, and both ends are idempotent. The whole correction
    // loop hangs off `manual`, so an interactiveMoveResizeFinished that does not arrive -- a window
    // that goes away mid-drag, a signal KWin does not send for the gesture that ended it -- used to
    // leave the flag set and silently stop the tiler reconciling anything, for the rest of the session.
    w.interactiveMoveResizeStarted.connect(() => grabStarted(w));
    w.interactiveMoveResizeFinished.connect(() => grabFinished(w));
    if (w.interactiveMoveResizeStepped && w.interactiveMoveResizeStepped.connect) {
        w.interactiveMoveResizeStepped.connect(() => previewDrag(w));
    }
    if (w.moveResizedChanged && w.moveResizedChanged.connect) {
        w.moveResizedChanged.connect(() => { if (w.move || w.resize) grabStarted(w); else grabFinished(w); });
    }
}

// The selection marker. It follows the *selection*, not the active window, because that is the only
// thing on the screen that says Focus(Out) did anything: Super+U selects the group around the
// focused window and the next move or resize applies to the group, which until now changed what
// the next key meant and drew nothing.
//
// Nothing is drawn here any more. The marker is an empty window moved over the selected rect, and
// the focusdim effect dims every window the rect does not cover -- which is a compositing operation
// and therefore has no stacking order to lose to a menu. The outline this replaced did: it was an
// internal window, internal windows are in OverlayLayer, and the only repair available was to stop
// drawing while a menu was over it. See Selection.qml and focusdim/contents/code/main.js.
//
// The last thing the marker was told, so it is not told again. arrange() runs on every action and on
// every pass of the correction loop, and moving a PlasmaCore.Dialog that is already where it
// belongs is a real window being reconfigured -- the same reason the drop preview keeps a key.
let marked = null;

// The window the keyboard belongs to, which is not always the window KWin says is active. Opening
// a panel widget activates the popup -- `specialWindow` is KWin's own name for that set
// (isSpecialWindow(): desktop, dock, splash, toolbar, notification, OSD, applet popup) -- and the
// hint used to follow it, find nothing tilable, and go out. Opening the applet that configures the
// active hint was therefore the one reliable way to lose it.
//
// COSMIC never meets this: its panel is a layer-shell surface, and keyboard focus landing on one
// does not move the focused tiling element. `cur` is the nearest thing here -- the last window
// activated that was not chrome -- and falling back to it is what keeps the hint where the user
// left it until they come back to it. A dialog is not a special window and still takes the hint,
// which is right: it is a window, it is where the keyboard went, and it stays there.
function focusWindow() {
    try {
        const w = ws.activeWindow;
        if (w && !w.specialWindow) return w;
        if (cur && !cur.specialWindow) return cur;
    } catch (e) {}   // a window object outliving its window answers nothing; that is "no focus"
    return null;
}

function updateSelection() {
    if (!ui || typeof ui.showSelection !== "function") return;
    // While a drag is in flight the drop zone is already saying where things are going, and
    // dimming around a window that is following the cursor is noise.
    if (grab) { if (marked !== null) { marked = null; ui.hideSelection(); } return; }

    const sel = liveSelection();
    let geo = null;
    let node = null;
    if (sel) {
        node = sel;
        geo = sel.data.geo;
    } else {
        const w = focusWindow();
        if (!w || !w.normalWindow || w.minimized || w.fullScreen || w.desktops.length === 0 ||
            (ws.currentDesktop && w.desktops[0].id !== ws.currentDesktop.id)) {
            if (marked !== null) { marked = null; ui.hideSelection(); }
            return;
        }
        // The slot the layout gave it, which for a stack is the whole slot including the tab bar.
        // A window that refused its size is the one case where the two differ, and the marker then
        // covers the slot rather than following the window out of it.
        const n = nodeFor(refOf(w));
        node = n;
        geo = n ? n.data.geo : toGeo(fg(w));
    }
    if (!geo || geo.w <= 0 || geo.h <= 0) { if (marked !== null) { marked = null; ui.hideSelection(); } return; }
    // The rect is sent as it is. The outline used to be grown by the width of its pen so the line
    // landed just outside the window; a marker has no pen, and growing it would hand the effect a
    // rectangle half an inner gap wider than the slot -- which on a tight layout is a neighbour's
    // edge reaching the half of its own area that keeps it undimmed.
    const r = node ? selectionRect(node) : { x: geo.x, y: geo.y, width: geo.w, height: geo.h };
    // The mode is not in this key any more. The outline used to turn the accent colour while a mode
    // held the arrow keys; dimming has no second colour to spend on that, so modeOsd() is what says
    // it now -- see modeOsd() in main.qml.
    const key = rectKey(r);
    if (key === marked) return;
    marked = key;
    ui.showSelection(r.x, r.y, r.width, r.height);
}

// A maximized window leaves the tree; when restored it is tiled again.
function onMaximizeChanged(w) {
    batched(() => {
        if (isMaximized(w)) { if (attached(w)) { unmapWindow(w); forget(refOf(w)); } }
        else if (shouldTile(w) && !attached(w)) mapWindow(w, null);
    });
}
// Focusing a tilable window restores the maximized tiled windows around it.
function unmaximizeOthers(active) {
    if (!active || !canTile(active)) return;
    const key = keyOf(active);
    for (const w of allWindows()) {
        if (w === active || !canTile(w) || keyOf(w) !== key) continue;
        if (isMaximized(w)) { try { w.setMaximize(false, false); } catch (e) {} }
    }
}

// A popup -- a menu, a context menu, a tooltip -- is ignored here and nowhere else. It used to be
// tracked, because the outline could not be stacked under one and had to stop drawing while one
// covered it. Dimming is applied to the windows themselves, so a menu is simply above them and
// nothing has to know that one opened.
function onAdded(w) {
    batched(() => {
        if (DEBUG) log("window added: " + w.resourceClass + " normal=" + w.normalWindow + " tilable=" + isTilable(w));
        try { connectWindow(w); } catch (e) { log("connect error: " + e); }
        // A new tilable window that opens maximized is un-maximized and tiled.
        if (canTile(w) && isMaximized(w)) { try { w.setMaximize(false, false); } catch (e) {} }
        if (shouldTile(w)) mapWindow(w, null);
    });
    // After the tiler, not beside it. As two scripts these ran in whatever order KWin happened to
    // deliver the signal in, so the trailing empty workspace could be collected out from under a
    // space the tiler was laying out. One owner, one order.
    try { ensureLastEmpty(null); } catch (e) { log("workspace list error: " + e); }
}
function onRemoved(w) {
    const ref = refOf(w);
    batched(() => {
        if (grab && grab.w === w) {
            const g = grab;
            grab = null; pending = null; manual = false; hidePreview();
            const sp = spaces.get(g.key);
            if (sp) {
                if (g.dropNode) sp.tiling = C.unmapInternal(sp.tiling, g.dropNode);
                if (g.phNode) sp.tiling = C.unmapInternal(sp.tiling, g.phNode);
                homeOf.delete(ref);
                layout(g.key);
            }
        }
        try { unmapWindow(w); } catch (e) { homeOf.delete(ref); }
    });
    forget(ref);
    windowOf.delete(ref);
    connected.delete(ref);
    minimums.delete(ref);
    overflowSince.delete(ref);
    lastSibling.delete(ref);
    borderSaved.delete(ref);
    if (cur === w) cur = null;
    if (prev === w) prev = null;
    try { updateSelection(); } catch (e) {}
    // `w` is passed along because KWin still lists a window it has just announced the removal of,
    // and counting it would keep its workspace alive by one.
    try { ensureLastEmpty(w); } catch (e) { log("workspace list error: " + e); }
}

// Minimized windows come back next to the window they sat beside.
function rememberSibling(w) {
    const ref = refOf(w);
    const n = nodeFor(ref);
    if (!n || !n.parent) { lastSibling.delete(ref); return; }
    const sibs = n.parent.children.filter((c) => c !== n);
    for (const s of sibs) {
        const m = C.preOrder(s).find((x) => C.isMapped(x.data));
        if (m) { lastSibling.set(ref, m.data.ref); return; }
    }
    lastSibling.delete(ref);
}
function restoreSlot(w) {
    const ref = refOf(w);
    const sib = lastSibling.get(ref);
    lastSibling.delete(ref);
    const m = sib ? winOf(sib) : null;
    if (m && m !== w && attached(m) && !m.minimized && keyOf(m) === keyOf(w)) {
        prev = cur; cur = m;      // mapWindow splits the focused node, and that is the one we want
        mapWindow(w, null);
        cur = prev; prev = null;
        return;
    }
    mapWindow(w, null);
}

// ---------- the correction loop ----------
//
// Everything above assumes KWin does what it is told. It does not always: a client refuses a
// size, an application maps a window the script never hears about, a panel appears and the work
// area moves. This runs on a timer and puts the layout back.
// Collects the workspace that was just walked off, once the slide has finished. Upstream does it on
// the very switch; here it has to wait, for the reason given at goWorkspace().
export function sweepWorkspaces() {
    try { ensureLastEmpty(null); } catch (e) { log("workspace list error: " + e); }
}
export function enforceSoon() { if (ui && ui.enforceTimer) ui.enforceTimer.restart(); }
export function reconcile() { batched(reconcileNow); }
function reconcileNow() {
    if (!grabbedNow()) {
        // KWin never told us the drag ended. Finish it rather than forget it: the window's slot is
        // standing open as a placeholder, and dropping the grab on the floor would leave the
        // placeholder in the tree and the window outside it for the rest of the session.
        if (grab) grabFinished(grab.w);
        manual = false;
    }
    if (manual || grab) return;

    const alive = new Set();
    for (const w of allWindows()) {
        alive.add(refOf(w));
        try {
            if (w.move || w.resize || attached(w) || !shouldTile(w)) continue;
            connectWindow(w);
            mapWindow(w, null);
        } catch (e) { log("reconcile error: " + e); }
    }
    for (const ref of Array.from(homeOf.keys())) {
        if (alive.has(ref)) continue;
        // Through unmapRef, not through the window: the window may already be gone, and deleting
        // the homeOf entry while its leaf stays in the tree is what leaves a slot nothing will
        // ever write to.
        try { for (const k of unmapRef(ref)) layout(k); } catch (e) { homeOf.delete(ref); }
        forget(ref);
        windowOf.delete(ref);
    }
    audit();
    // A stack whose leaf is gone leaves a bar behind; nothing else would ever take it down.
    const seen = new Set();
    for (const sp of spaces.values()) {
        for (const n of C.preOrder(sp.tiling)) if (C.isMapped(n.data) && n.data.stackId) seen.add(n.data.stackId);
    }
    for (const id of Array.from(stacksUi.keys())) {
        if (!seen.has(id)) { const s = stacksUi.get(id); if (s.item) { try { s.item.destroy(); } catch (e) {} } stacksUi.delete(id); }
    }
    if (areaChanged()) layoutAll();
    enforce();
}

// Every leaf names a window that exists, sits on the space that holds it, and appears in exactly
// one leaf of one space. That is the invariant the whole write path rests on, and breaking it is
// invisible everywhere except on the screen: a leaf whose window is gone, or whose window is being
// written from a second leaf somewhere else, is measured and then never written into, which is a
// rectangle of wallpaper in the middle of the layout.
//
// So it is checked rather than assumed, every pass, and repaired out loud. A repair that says
// nothing turns a bug into "it looked odd once"; this one leaves the ref, the space and the reason
// in the journal whether or not Debug is on.
function dropRefFromNode(sp, n, ref) {
    const d = n.data;
    const i = d.windows.indexOf(ref);
    if (i >= 0) d.windows.splice(i, 1);
    if (d.windows.length === 0) {
        dropStackUi(d);
        sp.tiling = C.unmapInternal(sp.tiling, n);
        return;
    }
    C.stackSetActive(d, Math.min(d.active, d.windows.length - 1));
}

// A group's size vector has one entry per child, and measure() relies on that without checking:
// it pushes one rect per size and pops one per child, so a group that disagrees does not fail --
// it hands a child the rect meant for someone else and strands the rest. Repaired by sharing the
// length the group already has evenly, which loses the proportions of one group and keeps the
// layout a layout.
function repairArity(n) {
    const d = n.data;
    const want = n.children.length;
    const total = d.sizes.reduce((a, b) => a + b, 0) || C.lengthOf(d.orientation, d.geo);
    const each = C.idiv(total, Math.max(1, want));
    d.sizes = [];
    for (let i = 0; i < want; i++) d.sizes.push(each);
    if (want > 0) d.sizes[want - 1] += total - each * want;
}

function audit() {
    const seen = new Set();
    for (const [key, sp] of spaces) {
        const strays = [];
        const ghosts = [];
        let repaired = 0;
        for (const n of C.preOrder(sp.tiling)) {
            if (n.data && C.isPlaceholder(n.data)) {
                // A placeholder belongs to a drag. One still in the tree when no drag is holding
                // it is a slot that is measured and never written into -- a rectangle of wallpaper
                // in the middle of the layout -- and it is invisible to every other check here,
                // because all of those ask about the window in a leaf and this leaf has none.
                if (grab && (grab.phNode === n || grab.dropNode === n)) continue;
                ghosts.push(n);
                continue;
            }
            if (!n.data) {
                log("audit: " + key + " a node carries no data at all -- taking it out");
                sp.tiling = C.unmapInternal(sp.tiling, n);
                repaired += 1;
                continue;
            }
            if (C.isGroup(n.data)) {
                if (n.data.sizes.length !== n.children.length) {
                    log("audit: " + key + " group has " + n.data.sizes.length + " sizes for " +
                        n.children.length + " children -- splitting it evenly");
                    repairArity(n);
                    repaired += 1;
                }
                continue;
            }
            if (!C.isMapped(n.data)) continue;
            for (const ref of n.data.windows.slice()) {
                const w = winOf(ref);
                if (!w) { strays.push([n, ref, "its window is gone"]); continue; }
                if (seen.has(ref)) { strays.push([n, ref, "a second leaf already holds it"]); continue; }
                if (keyOf(w) !== key) { strays.push([n, ref, "it belongs to " + keyOf(w)]); continue; }
                seen.add(ref);
                homeOf.set(ref, key);
            }
        }
        for (const n of ghosts) {
            log("audit: " + key + " a " + n.data.type + " placeholder outlived its drag -- taking it out");
            sp.tiling = C.unmapInternal(sp.tiling, n);
            repaired += 1;
        }
        for (const [n, ref, why] of strays) {
            const w = winOf(ref);
            log("audit: " + key + " dropping " + (w ? w.resourceClass + " " : "") + ref + " -- " + why);
            dropRefFromNode(sp, n, ref);
            // The next pass adopts it wherever it really belongs; saying it is here would be the
            // same lie that got it dropped.
            if (homeOf.get(ref) === key) homeOf.delete(ref);
            forget(ref);
        }
        if (strays.length || repaired) layout(key);
    }

    // And the other direction, which is the one that does not show up as a hole but as windows
    // sitting wherever they were last written: a ref homeOf claims is mapped, that no tree holds.
    // Every part of this file reads homeOf to decide whether a window is already handled, so such
    // a window is adopted by nothing and laid out by nothing until the claim is dropped.
    for (const ref of Array.from(homeOf.keys())) {
        if (seen.has(ref)) continue;
        const sp = spaces.get(homeOf.get(ref));
        if (sp && C.floatingIndex(sp, ref) >= 0) continue;
        const w = winOf(ref);
        log("audit: " + (w ? w.resourceClass + " " : "") + ref + " is claimed by " +
            homeOf.get(ref) + " and held by no tree -- letting it be tiled again");
        homeOf.delete(ref);
        forget(ref);
    }
}

// Work area changes (a panel added or resized, a monitor coming and going).
function areaChanged() {
    for (const [key, sp] of spaces) {
        const a = areaOf(key);
        if (!a || !sp.area) continue;
        if (Math.abs(a.x - sp.area.x) > 1 || Math.abs(a.y - sp.area.y) > 1 ||
            Math.abs(a.w - sp.area.w) > 1 || Math.abs(a.h - sp.area.h) > 1) return true;
    }
    return false;
}

const rectsOverlap = (a, b) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 4 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 4;

// A window that moved, grew past its slot, was maximized or overlaps a neighbour makes its whole
// space be laid out again.
function enforce() {
    const dirty = new Set();
    const bySpace = new Map();
    const maximized = [];
    for (const [ref, key] of Array.from(homeOf)) {
        const w = winOf(ref);
        if (!w) continue;
        if (w.minimized || w.fullScreen || w.desktops.length === 0) continue;
        if (isMaximized(w)) { maximized.push(w); continue; }
        if (isHidden(ref)) continue;
        const sp = spaces.get(key);
        if (!sp || !sp.area) continue;
        if (!bySpace.has(key)) bySpace.set(key, []);
        bySpace.get(key).push(w);
        const a = applied.get(ref);
        if (!a) { dirty.add(key); continue; }
        const g = fg(w);
        // The window refuses to shrink to its slot: remember its minimum so the layout reserves it.
        if (learnMinimum(ref, w, g, a, sp.area)) dirty.add(key);
        // A window that has not budged since the last pass was already asked to fit its slot. Some
        // clients simply will not take the size they are given; asking them again every pass cannot
        // change the answer and only restarts their geometry animation, which reads as flickering.
        const now = rectKey(g);
        const budged = lastSeen.get(ref) !== now;
        lastSeen.set(ref, now);
        // The same tolerance the write path uses, and for the same reason: a window one pixel short
        // of its slot has taken it. Comparing the keys as strings recorded every terminal on the
        // screen as having refused.
        if (inPlace(g, a)) refused.delete(ref);
        else if (!budged) refused.set(ref, { want: rectKey(a), at: now });   // it had its chance
        if (!budged) continue;
        if (Math.abs(g.x - a.x) > 2 || Math.abs(g.y - a.y) > 2 ||
            g.width > a.width + 2 || g.height > a.height + 2 ||
            g.width < a.width - 48 || g.height < a.height - 48) dirty.add(key);
    }
    for (const w of maximized) { try { batched(() => { unmapWindow(w); forget(refOf(w)); }); } catch (e) {} }
    for (const [key, list] of bySpace) {
        if (dirty.has(key) || (spaces.get(key) || {}).infeasible) continue;
        for (let i = 0; i < list.length && !dirty.has(key); i++) {
            for (let j = i + 1; j < list.length; j++) {
                if (rectsOverlap(fg(list[i]), fg(list[j]))) { dirty.add(key); break; }
            }
        }
    }
    for (const key of dirty) {
        for (const [ref, k] of homeOf) if (k === key) applied.delete(ref);
        layout(key);
    }
}

// The minimum is learned from what the client actually did. Clients round their size to whole
// character cells, so only a clearly larger size counts, and only one that is still too big a
// second and a half later -- a client resizes asynchronously and the first answer is not its last.
function learnMinimum(ref, w, g, a, area) {
    const known = minimums.get(ref);
    const SLACK = 40;
    const ow = g.width > a.width + SLACK, oh = g.height > a.height + SLACK;
    if (!ow && !oh) {
        overflowSince.delete(ref);
        if (known) {    // forget minimums the window no longer needs
            if (g.width < known.w - 2) known.w = g.width;
            if (g.height < known.h - 2) known.h = g.height;
        }
        return false;
    }
    const s = overflowSince.get(ref);
    const now = Date.now();
    if (!s || s.ow !== ow || s.oh !== oh || (ow && Math.abs(s.w - g.width) > 2) || (oh && Math.abs(s.h - g.height) > 2)) {
        overflowSince.set(ref, { t: now, w: g.width, h: g.height, ow, oh });
        return false;
    }
    if (now - s.t < 1500) return false;
    const want = known || { w: 0, h: 0 };
    let changed = false;
    const capW = area.w * 0.75, capH = area.h * 0.75;
    if (ow && g.width > want.w + 1) { want.w = Math.min(g.width, capW); changed = true; }
    if (oh && g.height > want.h + 1) { want.h = Math.min(g.height, capH); changed = true; }
    const m = declaredMin(w);
    if (m.width > want.w) { want.w = m.width; changed = true; }
    if (m.height > want.h) { want.h = m.height; changed = true; }
    if (changed) minimums.set(ref, want);
    return changed;
}

// ---------- settings ----------
//
// KWin hands a kcfg Bool entry back as the string "true" or "false", so a bare readConfig result
// cannot be used as a condition -- "false" is truthy. Every boolean goes through this.
function cfgBool(key, fallback) {
    const v = kw.readConfig(key, fallback);
    return typeof v === "boolean" ? v : String(v).toLowerCase() === "true";
}
function cfgInt(key, fallback) {
    const v = parseInt(kw.readConfig(key, fallback), 10);
    return Number.isFinite(v) ? v : fallback;
}
// Read once, at startup. KWin gives a script no signal for its own configuration changing, and the
// session has to be restarted for a new script anyway.
function readSettings() {
    if (!kw || typeof kw.readConfig !== "function") return;   // keep the defaults
    GAP_INNER = cfgInt("GapInner", GAP_INNER);
    GAP_OUTER = cfgInt("GapOuter", GAP_OUTER);
    DEBUG = cfgBool("Debug", DEBUG);
    DROP_PREVIEW = cfgBool("DropPreview", DROP_PREVIEW);
    TAB_BAR = cfgBool("TabBar", TAB_BAR);
    BAR_HEIGHT = cfgInt("BarHeight", BAR_HEIGHT);
    NEW_WORKSPACE_TILED = cfgBool("NewWorkspaceTiled", NEW_WORKSPACE_TILED);
    DYNAMIC_WORKSPACES = cfgBool("DynamicWorkspaces", DYNAMIC_WORKSPACES);
    barH = TAB_BAR ? BAR_HEIGHT : 0;
}

// Read again, and act on what changed. Reached only by name, from the applet, after it has written
// the key and sent `org.kde.KWin.reconfigure`.
//
// That reconfigure is the part that is not obvious, and it was measured rather than assumed: the
// signal does not *reach* a script -- there is no hook for it and nothing re-runs -- but it does
// make KWin drop the configuration it is holding, so a script asked to read again afterwards gets
// what is on disk. A probe script loaded over D-Bus read its key, the key was changed underneath
// it, it read the same value again, a reconfigure was sent, and the next read was the new value.
// Without it this function would re-read the same numbers and relayout to no effect, which is the
// kind of failure that looks like the write not working.
//
// `inner`/`outer` are what the layout reads and GAP_* what the configuration says; main() copies
// one into the other at startup and this is the other place that has to.
function reloadSettings() {
    readSettings();
    inner = GAP_INNER;
    outer = GAP_OUTER;
    // The selection is said again even when it has not moved, which is what `marked` otherwise
    // suppresses. This handler is what the applet invokes after it unloads and loads the outline
    // plugin to apply a thickness or a colour, and a freshly loaded plugin knows nothing: it has
    // to be told the rect it was already told, or the line stays off until the selection happens
    // to move. The same is true of the whole layout, which is why layoutAll() is here too.
    marked = null;
    batched(() => { layoutAll(); updateSelection(); });
    publishTiling(true);
}

export function main(api, q) {
    ws = api.workspace; kw = api.kwin; ui = q.root; dbg = q.dbg;
    readSettings();
    inner = GAP_INNER; outer = GAP_OUTER;
    ws.windowAdded.connect(onAdded);
    ws.windowRemoved.connect(onRemoved);
    ws.windowActivated.connect((w) => {
        // Desktop chrome taking the keyboard is not a focus change. A panel popup, a notification,
        // an OSD: KWin activates them and the keyboard really does go there, but nothing about the
        // tiling has moved and the window underneath is the one the user comes back to. Taking it
        // as a focus change exited the active mode, dropped the group selection and hid the active
        // hint -- so opening the applet cancelled a swap in progress and blanked the very thing the
        // applet exists to configure. See focusWindow() for the other half of this.
        if (w && w.specialWindow) return;
        // Focus moving is the end of a resize, and the middle of a swap: swapping is navigating
        // to the window to trade with, so the focus going elsewhere is the gesture, not its end.
        if (w && w !== cur) { prev = cur; cur = w; if (mode !== "swap") exitMode(); }
        clearSelection();
        // Activating a stacked window from the task manager or Alt+Tab brings it forward in its
        // stack, which is the only way to reach a member the active one is covering.
        if (w) {
            const n = nodeFor(refOf(w));
            if (n && n.data.stacked && n.data.ref !== refOf(w)) {
                batched(() => { setActiveMember(n.data, n.data.windows.indexOf(refOf(w))); layoutOf(n.data.ref); });
            }
        }
        unmaximizeOthers(w);
        updateSelection();
        reconcile();
    });
    ws.currentDesktopChanged.connect(() => {
        batched(() => { layoutAll(); updateSelection(); reconcileNow(); publishTiling(false); });
        if (ui && ui.sweepTimer) ui.sweepTimer.restart();
    });
    if (ws.virtualScreenGeometryChanged) ws.virtualScreenGeometryChanged.connect(() => batched(layoutAll));
    cur = ws.activeWindow;
    try { ensureLastEmpty(null); } catch (e) { log("workspace list error: " + e); }
    try { updateSelection(); } catch (e) {}
    try { publishTiling(true); } catch (e) { log("publish error: " + e); }
    batched(() => {
        for (const w of allWindows()) {
            try { connectWindow(w); } catch (e) { log("connect error: " + e); }
            try { if (shouldTile(w)) mapWindow(w, null); } catch (e) { log("tile error: " + e); }
        }
    });
}

function dump() {
    const lines = [];
    for (const [key, sp] of spaces) {
        lines.push("space " + key + " area=" + JSON.stringify(sp.area) + " tiling=" + sp.tilingEnabled +
            " floating=" + sp.floating.length);
        (function walk(n, d) {
            if (!n) return;
            const pad = "  ".repeat(d + 1);
            if (C.isGroup(n.data)) {
                lines.push(pad + n.data.orientation + " " + JSON.stringify(n.data.sizes));
                for (const c of n.children) walk(c, d + 1);
            } else if (C.isMapped(n.data)) {
                const names = n.data.windows.map((r) => { const w = winOf(r); return w ? String(w.resourceClass) : r; });
                lines.push(pad + (n.data.stacked ? "stack " : "") + names.join(", ") +
                    " [" + rectKey(toRect(n.data.geo)) + "]");
            } else {
                lines.push(pad + "placeholder " + n.data.type + " [" + rectKey(toRect(n.data.geo)) + "]");
            }
        })(sp.tiling, 0);
    }
    // Enough per window to tell a layout that is wrong from a window that is not there. A slot
    // showing wallpaper with a tree that checks out is a window the module believes in and the
    // screen does not -- minimized, hidden behind a capture, or refusing the rect it was handed --
    // and none of that is visible from the tree alone.
    for (const w of allWindows()) {
        const ref = refOf(w);
        const want = applied.get(ref);
        lines.push("win " + (w.resourceClass || "?") + " normal=" + w.normalWindow +
            " tilable=" + isTilable(w) + " attached=" + attached(w) +
            " min=" + !!w.minimized + " full=" + !!w.fullScreen + " hidden=" + !!w.hidden +
            " at=" + rectKey(fg(w)) + (want ? " want=" + rectKey(want) : "") +
            (refused.has(ref) ? " REFUSED(" + refused.get(ref).want + " from " + refused.get(ref).at + ")" : ""));
    }
    log(lines.join("\n"));
}
