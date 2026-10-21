// SPDX-FileCopyrightText: 2024 System76, Inc. <info@system76.com>

// GPL-3.0. cosmic-comp is System76's, and so is the behaviour; the KWin plumbing is KOSMIC's.

import * as C from "./core.mjs";

let ws, kw, ui, dbg;

// KWin's virtual desktops are global with no per-output API, so a desktop on two monitors is two spaces.
const spaces = new Map();
const windowOf = new Map();
const homeOf = new Map();
const connected = new Set();
const lastSibling = new Map();

const minimums = new Map();
const lastSeen = new Map();
const overflowSince = new Map();
const borderSaved = new Map();
const MIN_FLOOR = { w: 200, h: 120 };

let cur = null, prev = null;
let manual = false;
let grab = null;
let phSeq = 0, stackSeq = 0;

let GAP_INNER = 8;
let GAP_OUTER = 0;
let DEBUG = false;
let DROP_PREVIEW = true;
let TAB_BAR = true;
let BAR_HEIGHT = 28;
let NEW_WORKSPACE_TILED = true;
let barH = BAR_HEIGHT;
let inner = 8, outer = 0;

const exceptions = C.compileExceptions(C.DEFAULT_EXCEPTIONS,
    (rule, err) => log("bad tiling exception " + JSON.stringify(rule) + ": " + err));

export function log(m) { if (dbg) dbg(String(m)); }

const clone = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
const toGeo = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
const toRect = (g) => ({ x: g.x, y: g.y, width: g.w, height: g.h });
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const north = (r) => [r.x + r.width / 2, r.y];
const east = (r) => [r.x + r.width, r.y + r.height / 2];
const south = (r) => [r.x + r.width / 2, r.y + r.height];
const west = (r) => [r.x, r.y + r.height / 2];
const fg = (w) => ({ x: w.frameGeometry.x, y: w.frameGeometry.y, width: w.frameGeometry.width, height: w.frameGeometry.height });

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

// A size is reported only when the client gave one; zero means "unset" to core.isDialog.
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

function spaceFor(key) {
    let sp = spaces.get(key);
    if (!sp) { sp = C.newWorkspace(NEW_WORKSPACE_TILED); sp.area = null; spaces.set(key, sp); }
    return sp;
}
const spaceOf = (ref) => spaces.get(homeOf.get(ref));

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

let requested = new Map();
const applied = new Map();
// A refusal holds only while the window is still where it was when it refused; keep both want and at.
const refused = new Map();
const rectKey = (r) => Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.width) + "x" + Math.round(r.height);

// KWin snaps to the device pixel grid (788 -> 788.125 at scale 1.6) and terminals round to cells;
// tolerance is one logical pixel, inclusive: Konsole lands exactly one short on every tile.
const TOLERANCE = 1;
const inPlace = (c, g) =>
    Math.abs(c.x - g.x) <= TOLERANCE && Math.abs(c.y - g.y) <= TOLERANCE &&
    Math.abs(c.width - g.width) <= TOLERANCE && Math.abs(c.height - g.height) <= TOLERANCE;

// Intermediate geometry restarts KWin's geometry animation and flickers; write once per action.
let batch = 0;
function batched(fn) {
    batch += 1;
    try { fn(); } finally { batch -= 1; }
    arrange();
}

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
        // Rewriting a rect the window already has replays the geometry animation (every window twitches).
        if (inPlace(c, g)) { refused.delete(ref); continue; }
        // Re-asking a client that did not move only restarts its resize; cosmic-comp likewise waits for acks
        // (TilingBlocker, CosmicMapped::latest_size_committed).
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

function layout(key) {
    const sp = spaces.get(key);
    if (!sp) return;
    const area = areaOf(key);
    // An empty space is dropped unless its tiling flag differs from the default: that is a user decision
    // and collecting it would undo it.
    if (!area) {
        if (!sp.tiling && sp.tilingEnabled === NEW_WORKSPACE_TILED) spaces.delete(key);
        return;
    }
    sp.area = area;
    const gaps = { outer: outer, inner: inner };
    let r = C.measure(sp.tiling, area, gaps);
    sp.tiling = r.root;
    // Minimums are read against this layout's geometry, and group orientation and parent width depend on
    // each other, so measure repeats; a layout still moving after three passes will not settle.
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

// ACCEPTED DIVERGENCE: cosmic-comp has no minimum sizes; here the size vector avoids slots a window is
// known to refuse. The old orientation flip is gone: it made stubborn windows alternate.
function declaredMin(w) {
    try {
        const m = w.minSize;
        if (m && m.width > 0 && m.height > 0) return { width: Math.min(m.width, 1400), height: Math.min(m.height, 900) };
    } catch (e) {}
    return { width: 0, height: 0 };
}

// A group has no term of its own: measure() divides its length exactly; gaps come from each leaf's rect.
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
    // Same arithmetic as measure(): half an inner gap on a side with a neighbour, a whole one otherwise.
    const near = o === C.VERTICAL ? C.LEFT : C.UP;
    const far = o === C.VERTICAL ? C.RIGHT : C.DOWN;
    v += C.hasAdjacentNode(n, near) ? C.idiv(inner, 2) : inner;
    v += C.hasAdjacentNode(n, far) ? C.idiv(inner, 2) : inner;
    return v;
}

// Checking only the split axis made two stubborn windows alternate orientation on every pass.
function fitsAlong(n, q) {
    const cross = q === C.VERTICAL ? C.HORIZONTAL : C.VERTICAL;
    let sum = 0, widest = 0;
    for (const c of n.children) { sum += minAlong(c, q); widest = Math.max(widest, minAlong(c, cross)); }
    return sum <= C.lengthOf(q, n.data.geo) && widest <= C.lengthOf(cross, n.data.geo);
}

function clampSizes(root) {
    let changed = false, infeasible = false;
    if (!root) return { changed, infeasible };

    // Leaves first: a group's minimum depends on its children's orientation (reversed pre-order).
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

// COSMIC splits the focused node, but KWin's focus is already the new window, so use the previous one.
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
    // A window some tree still holds would get two leaves, only one writable; the other is a hole.
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

// Does not trust homeOf: a node it forgot is invisible elsewhere and shows as a rectangle of wallpaper.
function unmapRef(ref) {
    const touched = [];
    homeOf.delete(ref);
    for (const [key, sp] of spaces) {
        let hit = false;
        if (C.floatingIndex(sp, ref) >= 0) { C.unmapFloating(sp, ref); hit = true; }
        for (;;) {
            const n = nodeHolding(sp.tiling, ref);
            if (!n) break;
            hit = true;
            const d = n.data;
            if (d.windows.length > 1) {
                const i = d.windows.indexOf(ref);
                d.windows.splice(i, 1);
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

function forget(ref) {
    applied.delete(ref);
    refused.delete(ref);
    lastSeen.delete(ref);
}

// Plasma already places floating windows; only map_anchored's two-thirds first-float size is kept.
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

// Focus can sit on a window of another desktop; "toggle tiling" must act on the space on screen.
function currentKey() {
    const now = ws.currentDesktop ? ws.currentDesktop.id : null;
    const here = (m) => m && m.desktops.length === 1 && (!now || m.desktops[0].id === now);
    const w = ws.activeWindow;
    if (here(w)) return homeOf.get(refOf(w)) || keyOf(w);
    for (const m of allWindows()) {
        if (!here(m) || !isTilable(m)) continue;
        return homeOf.get(refOf(m)) || keyOf(m);
    }
    // Nothing is open here: the space does not exist yet, so the key uses the active output in place of
    // the window's.
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
    // core.setTilingEnabled reads the area only to re-map windows between layers; an empty space has none.
    if (!area && (sp.tiling || sp.floating.length)) return;
    C.setTilingEnabled(sp, !sp.tilingEnabled, area);
    for (const f of sp.floating) { const m = winOf(f.ref); if (m) placeFloating(m, sp); }
    for (const [ref, k] of homeOf) if (k === key) forget(ref);
    layout(key);
    publishTiling(false);
}

// A KWin script can only call outwards, so state is pushed to the applet (see state/). `force` answers
// the applet's liveness request even when nothing changed.
let published = null;
function publishTiling(force) {
    if (!ui || typeof ui.publishTiling !== "function") return;
    const key = currentKey();
    const sp = key === null ? null : spaces.get(key);
    const on = sp ? sp.tilingEnabled : NEW_WORKSPACE_TILED;
    if (!force && on === published) return;
    published = on;
    ui.publishTiling(on);
}

// ACCEPTED DIVERGENCE: COSMIC walks the tree; the answers differ only when a window spills over its
// neighbour, and then the geometric one is what the user sees.
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

// KWin has no group focus, so the selection lives here; the focusdim effect makes it visible.
let selected = null;

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

// KWin can hide a window only by minimizing (out of the task manager and Alt+Tab), so members share a
// rect and the active one is raised.
const stacksUi = new Map();
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

// Activated rather than raised: the task manager and Alt+Tab read the activation.
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
    for (const m of C.preOrder(sp.tiling)) if (C.isMapped(m.data)) syncDecorations(m.data);
    if (!n.data.stacked) dropStackUi(n.data);
    for (const m of n.data.windows) forget(m);
    layoutOf(ref);
    ws.activeWindow = w;
}

// Not COSMIC's: a separate dissolve avoids needing to know whether a toggle would make or dissolve.
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

function toggleOrient() {
    const n = selectedNode();
    const g = n && (C.isGroup(n.data) ? n : n.parent);
    if (!g) return;
    g.data.orientation = g.data.orientation === C.VERTICAL ? C.HORIZONTAL : C.VERTICAL;
    const w = ws.activeWindow;
    layoutOf(refOf(w || cur));
    if (w) ws.activeWindow = w;
}

// Mode arrows are registered shortcuts because a KWin script receives only what it registers;
// SwapWindow is modal because keybindings.ron gives its action no direction.
let mode = "";

// Auto-repeat reaches global shortcuts (input.cpp :1099), so repeats of the arming chord are
// recognised by timing: an activation within ARM_DELAY of the last one is a repeat.
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

// Step as upstream (Shell::resize :4814): starts at 10, +2 per repeat, stops at 20.
// ACCEPTED DIVERGENCE: a script never gets the key release, so the step resets on arming and on
// direction change instead of on key-up.
const RESIZE_FROM = 10, RESIZE_BY = 2, RESIZE_TO = 20;
// Upstream repeats a held key on a 200ms timer; KWin shortcuts are unthrottled and every repeat
// rewrites geometry and restarts the animation.
const RESIZE_REPEAT = 200;
let resizeAmount = RESIZE_FROM;
let resizeLast = "";
let resizeAt = 0;
// The arrow names the size, not the edge: Right widens, Left narrows, Down heightens, Up shortens.
// The trailing seam is tried first, then the leading one: a neighbour sitting on MIN_PANE has nothing
// to give, and asking the other side is a second chance at the same request.
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
    const axis = AXIS[dir];
    const towards = axis.grow ? C.OUTWARDS : C.INWARDS;
    for (const edge of axis.edges) {
        const r = C.resize(sp.tiling, n, towards, edge, resizeAmount);
        if (!r.changed) continue;
        layoutOf(refOf(w));
        return;
    }
}

// As upstream (grabs/swap.rs, input/mod.rs :2420): trade when the mode ends. Swapping with the
// geometric neighbour on every arrow would only trade the two back.
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
    // homeOf must follow the data: across two spaces it is the only thing that moves them.
    for (const ref of a.data.windows) homeOf.set(ref, keyA);
    for (const ref of b.data.windows) homeOf.set(ref, keyB);
    for (const ref of a.data.windows.concat(b.data.windows)) forget(ref);
    layout(keyA);
    if (keyB !== keyA) layout(keyB);
    // Focus stays on the marked window, as upstream (focus/mod.rs :853).
    const back = winOf(fromRef);
    if (back) ws.activeWindow = back;
}

// Only left and right continue past the tree edge (workspaces are a horizontal strip); COSMIC would
// fall back to MoveToOutput on up and down.
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
            syncRefs(sp, homeOf.get(ref));
            layoutOf(ref);
            // shift_focus is upstream's and is not always the moved window; overriding it would change the key.
            const to = r.shiftFocus ? winOf(r.shiftFocus.data.ref) : winOf(ref);
            if (to) ws.activeWindow = to;
            return;
        }
        if (r.result === C.MOVE_NONE) return;
        // The fallback is the neighbouring workspace, a move for one window and never for a selected group.
        if (group) return;
    }
    if (dir === "left") moveToWorkspace(-1, C.LEFT);
    else if (dir === "right") moveToWorkspace(1, C.RIGHT);
}

function syncRefs(sp, key) {
    if (!sp || !sp.tiling) return;
    for (const n of C.preOrder(sp.tiling)) {
        if (!C.isMapped(n.data)) continue;
        syncDecorations(n.data);
        for (const ref of n.data.windows) if (homeOf.get(ref) !== key) homeOf.set(ref, key);
    }
}

export function action(name) { batched(() => runAction(name)); }

// kglobalshortcutsrc is authoritative and a QML `sequence` is only its default, so mode-specific
// shortcuts stay unbound; the arrows stay bound to Focus and a mode reinterprets them here.
function runAction(name) {
    const m = /^(focus|window)-(left|right|up|down)$/.exec(name);
    if (m) {
        if (m[1] === "window") { exitMode(); return moveWindow(m[2]); }
        if (mode === "resize") return resizeStep(m[2]);
        return focusDir(m[2]);
    }
    switch (name) {
        case "dump": return dump();
        case "focus-in": exitMode(); return focusIn();
        case "focus-out": exitMode(); return focusOut();
        // Escape cannot be bound without taking it from the rest of the desktop, so the arming chord toggles.
        case "resize": return toggleMode("resize");
        case "swap-window": return toggleMode("swap");
        // Driven by kosmic-chordhold, which sees the key release; it blocks the chord so there are no repeats,
        // and both calls are idempotent because begin and end may not pair.
        case "swap-arm": if (mode !== "swap") enterMode("swap"); return;
        case "swap-commit": if (mode === "swap") exitMode(); return;
        case "resize-arm": if (mode !== "resize") enterMode("resize"); return;
        case "resize-release": if (mode === "resize") exitMode(); return;
        case "workspace-left": exitMode(); return moveToWorkspace(-1, C.LEFT);
        case "workspace-right": exitMode(); return moveToWorkspace(1, C.RIGHT);
        // Stepping past the last workspace must create one, so this lives here and not in KDE.
        case "workspace-next": exitMode(); return goWorkspace(1);
        case "workspace-prev": exitMode(); return goWorkspace(-1);
        // By position: KWin only has "Switch to Desktop N" for a fixed N, and the last one's number changes.
        case "workspace-last": exitMode(); return goLastWorkspace();
        case "workspace-move-last": exitMode(); return moveToLastWorkspace();
        case "orientation": exitMode(); return toggleOrient();
        case "floating": exitMode(); return toggleFloating();
        case "tiling": exitMode(); return toggleTiling();
        // By name only, via kglobalaccel after kwinrc is written: a script reads its config at load and
        // `reconfigure` does not reach it.
        case "new-workspace-tiled": NEW_WORKSPACE_TILED = true; return publishTiling(false);
        case "new-workspace-floating": NEW_WORKSPACE_TILED = false; return publishTiling(false);
        // Called just before the applet reads the value back; that ordering is the liveness check (see state/).
        case "publish-state": return publishTiling(true);
        case "reload-settings": return reloadSettings();
        case "stack": exitMode(); return toggleStack();
        case "stack-dissolve": exitMode(); return dissolveStack();
        case "stack-next": exitMode(); return cycleStack(1);
        case "stack-prev": exitMode(); return cycleStack(-1);
    }
    log("no handler for action " + name);
}

// A workspace is created past the edge only if the window is not alone, or walking right would mint
// one per keypress.
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

function emptyLast() {
    const ds = ws.desktops;
    const last = ds[ds.length - 1];
    if (!last || !occupied(null).has(last.id)) return last;
    ws.createDesktop(ds.length, "Desktop");
    return ws.desktops[ws.desktops.length - 1];
}
function moveToLastWorkspace() {
    const w = ws.activeWindow;
    if (!w || !w.normalWindow || w.desktops.length !== 1) return;
    const ds = ws.desktops;
    if (ds[ds.length - 1].id === w.desktops[0].id && !occupied(w).has(w.desktops[0].id)) return;
    const target = emptyLast();
    if (!target || target.id === w.desktops[0].id) return;
    sendToDesktop(w, target, C.RIGHT);
}
function goLastWorkspace() {
    const last = emptyLast();
    if (last) ws.currentDesktop = last;
}
function sendToDesktop(w, target, dir) {
    const tiled = attached(w);
    const oldKey = homeOf.get(refOf(w));
    if (tiled) unmapWindow(w);
    w.desktops = [target];
    forget(refOf(w));
    if (tiled || shouldTile(w)) mapWindow(w, dir);
    if (oldKey) layout(oldKey);
    ws.currentDesktop = target;
    ws.activeWindow = w;
}

// Provenance: this came in under MIT from an unrecorded source and the licence travelled with the
// file. It is GPL-3.0 now, as part of this one, and the notice stays here for that reason.

// Guards re-entry: `currentDesktopChanged` lands in the tiler's own handler, which lays every space out.
let listBusy = false;

// Cleared once KWin's slide has finished (main.qml: sweepWhenIdle); nothing touches the desktop list
// until then.
let sweepPending = false;

// `skipPager` marks widgets and panels as not holding a workspace; `onAllDesktops` holds none in particular.
function holdsWorkspace(w, ignored) {
    return w !== ignored && w.normalWindow && !w.skipPager && !w.onAllDesktops;
}
function occupied(ignored) {
    const set = new Set();
    for (const w of allWindows()) {
        if (!holdsWorkspace(w, ignored)) continue;
        for (const d of w.desktops) set.add(d.id);
    }
    return set;
}

// A removed desktop leaves a space nothing can reach; layout() keeps empty spaces with a non-default
// tiling flag, so pruning here is the other half.
function dropDeadSpaces() {
    const live = new Set(ws.desktops.map((d) => d.id));
    for (const key of Array.from(spaces.keys())) {
        const at = key.lastIndexOf("|");
        if (at > 0 && !live.has(key.slice(at + 1))) spaces.delete(key);
    }
}

// Deleting a workspace the moment it is walked off broke KWin's slide: the grid collapsed under the
// animation. Hence nothing runs while one is in flight (sweepPending).
function ensureLastEmpty(ignored) {
    if (listBusy || sweepPending) return;
    listBusy = true;
    try {
        const used = occupied(ignored);
        const ds = Array.from(ws.desktops);
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

export function sweepWorkspaces() {
    sweepPending = false;
    try { ensureLastEmpty(null); } catch (e) { log("workspace list error: " + e); }
}
function desktopSwitched() {
    if (!ui || !ui.sweepWhenIdle) return;
    sweepPending = true;
    ui.sweepWhenIdle();
}

function neighbourDesktop(dir) {
    const ds = ws.desktops;
    const i = desktopIndex(ws.currentDesktop);
    const j = i + dir;
    if (j >= 0 && j < ds.length) return ds[j];
    listBusy = true;
    try {
        ws.createDesktop(dir > 0 ? ds.length : 0, "Desktop");
    } finally { listBusy = false; }
    return ws.desktops[dir > 0 ? ws.desktops.length - 1 : 0];
}

// Cleanup before the switch, never after: slide.cpp :269 re-reads the desktop grid every frame, so a
// removal mid-slide makes the window arrive from the wrong side (:381 fixes the ends once).
function goWorkspace(dir) {
    ensureLastEmpty(null);
    const ds = ws.desktops;
    const here = ws.currentDesktop;
    const i = desktopIndex(here);
    if (i < 0) return;
    const edge = (dir > 0 && i === ds.length - 1) || (dir < 0 && i === 0);
    if (edge && !occupied(null).has(here.id)) return;
    const d = neighbourDesktop(dir);
    if (d) ws.currentDesktop = d;
}

// cosmic-comp opens a DropZone placeholder; here the dragged window is never written to and the zone
// is also outlined, because an empty rectangle does not read as "the window goes here".
let pending = null;
let previewed = null;

function showPreview(r) {
    const key = rectKey(r);
    if (key === previewed) return;
    previewed = key;
    if (DEBUG) log("zone rect " + key);
    const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.width), h = Math.round(r.height);
    try {
        if (ui && ui.showZone && ui.showZone(x, y, w, h)) return;
        ws.showOutline(Qt.rect(x, y, w, h));
    } catch (e) { log("zone: " + e); }
}
function hidePreview() {
    if (previewed === null) return;
    previewed = null;
    try { if (ui && ui.hideZone) ui.hideZone(); } catch (e) {}
    try { ws.hideOutline(); } catch (e) {}
}
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

// measure() insets mapped nodes by the gaps but leaves groups and placeholders on the raw division
// (:2998), so the same insets are applied before framing them.
function contentRect(n) {
    const g = n.data.geo;
    if (!C.isGroup(n.data)) return { x: g.x, y: g.y, width: g.w, height: g.h };
    return slotRect(n);
}

// ACCEPTED DIVERGENCE: a client that refuses is drawn outside its slot, so the marker covers the union
// of the slot and what the window took; the slot alone still drives resize and move.
function selectionRect(n) {
    const r = contentRect(n);
    if (C.isGroup(n.data)) return r;
    const d = n.data;
    const ref = d.windows && d.windows.length ? d.windows[d.active] : d.ref;
    const w = winOf(ref);
    if (!w || w.minimized) return r;
    const f = fg(w);
    // Only a window in its own slot may enlarge the marker; elsewhere (other output, mid-handover) it
    // would drag the marker across the screen.
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
    // Without `data` there is nothing to put back on release, and a data-less node in the tree breaks
    // the next reconcile walk.
    if (!grab.data) return;
    const sp = spaces.get(grab.key);
    if (!sp) return;
    const cp = ws.cursorPos;
    // ACCEPTED DIVERGENCE: committing a zone changes the frame the next is measured in, so the layout would
    // flicker between split and stack; wait until the pointer travels EDGE_BAND (upstream's figure).
    if (grab.committedAt) {
        const dx = cp.x - grab.committedAt.x, dy = cp.y - grab.committedAt.y;
        if (Math.hypot(dx, dy) < C.EDGE_BAND) { pending = null; return; }
    }
    const z = C.zoneAt(sp.tiling, { x: cp.x, y: cp.y }, grab.zone);
    if (C.zonesEqual(z, grab.zone)) { pending = null; return; }
    if (C.zonesEqual(z, pending)) return;
    if (DEBUG) log("zone " + z.kind);
    pending = z;
    if (ui && ui.dragTimer) {
        ui.dragTimer.interval = (grab.zone && grab.zone.kind === C.ZONE_INITIAL_PLACEHOLDER)
            ? C.INITIAL_MOUSE_ANIMATION_DELAY : C.MOUSE_ANIMATION_DELAY;
        ui.dragTimer.restart();
    } else {
        commitZone();
    }
}

export function dragCommit() { batched(commitZone); }
function commitZone() {
    let z = pending;
    pending = null;
    if (!z || !grab || grab.resizing || !grab.data) return;
    const sp = spaces.get(grab.key);
    if (!sp) return;

    if (grab.dropNode) { sp.tiling = C.unmapInternal(sp.tiling, grab.dropNode); grab.dropNode = null; }
    grab.stackTarget = null;

    // The zone is re-read here: removing the previous drop zone can dissolve its group, so the `z.node`
    // the dwell timer waited on may no longer be in the tree.
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
    if (grab.phNode) { sp.tiling = C.unmapInternal(sp.tiling, grab.phNode); grab.phNode = null; }
    grab.zone = z;
    grab.committedAt = { x: ws.cursorPos.x, y: ws.cursorPos.y };
    layout(grab.key);
}

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
        if (g.dropNode) sp.tiling = C.unmapInternal(sp.tiling, g.dropNode);
        if (g.phNode) sp.tiling = C.unmapInternal(sp.tiling, g.phNode);
        layout(g.key);
        if (shouldTile(g.w)) mapWindow(g.w, null);
        return;
    }
    homeOf.set(ref, g.key);
    forget(ref);
    layout(g.key);
    // Signals for a desktop or output change are ignored during a grab, so the move is settled here.
    if (keyOf(g.w) !== g.key) {
        unmapWindow(g.w);
        if (shouldTile(g.w)) mapWindow(g.w, null);
        layout(g.key);
    }
}

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
    const lo = sizes[i] + d, hi = sizes[j] - d;
    const floor = C.MIN_PANE[req.orientation];
    if (lo < floor || hi < floor) return;
    sizes[i] = lo; sizes[j] = hi;
}

function grabStarted(w) {
    if (grab && grab.w === w) return;
    // A grab in flight for another window is finished, not overwritten; both drag ends arrive on two
    // signals and can interleave.
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
        // A zone not yet dwelled in still counts; a drag with no steps is read off the cursor, which is safe
        // because nothing was committed.
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
        manual = false;
        hidePreview();
    }
}
// KWin is the authority on whether a drag is in progress; the flag is only a cache of it.
function grabbedNow() {
    for (const w of allWindows()) { try { if (w.move || w.resize) return true; } catch (e) {} }
    return false;
}

function connectWindow(w) {
    const ref = refOf(w);
    if (connected.has(ref)) return;
    connected.add(ref);
    windowOf.set(ref, w);

    w.frameGeometryChanged.connect(() => {
        if (w === ws.activeWindow) updateSelection();
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
    }));
    w.fullScreenChanged.connect(() => batched(() => {
        if (w.fullScreen) { if (attached(w)) { unmapWindow(w); forget(ref); } }
        else if (shouldTile(w) && !attached(w)) mapWindow(w, null);
    }));
    // Not while dragged: KWin reports the new desktop as the pointer crosses; finishDrag settles it once.
    const moved = () => {
        if (grab && grab.w === w) return;
        if (!attached(w) || homeOf.get(ref) === keyOf(w)) return;
        batched(() => { unmapWindow(w); forget(ref); if (shouldTile(w)) mapWindow(w, null); });
    };
    w.desktopsChanged.connect(moved);
    if (w.outputChanged) w.outputChanged.connect(moved);
    // A missed interactiveMoveResizeFinished used to leave `manual` set and stop all reconciling for the
    // session, so both ways of hearing about a drag are used and both ends are idempotent.
    w.interactiveMoveResizeStarted.connect(() => grabStarted(w));
    w.interactiveMoveResizeFinished.connect(() => grabFinished(w));
    if (w.interactiveMoveResizeStepped && w.interactiveMoveResizeStepped.connect) {
        w.interactiveMoveResizeStepped.connect(() => previewDrag(w));
    }
    if (w.moveResizedChanged && w.moveResizedChanged.connect) {
        w.moveResizedChanged.connect(() => { if (w.move || w.resize) grabStarted(w); else grabFinished(w); });
    }
}

// The marker is an empty window and focusdim dims what its rect does not cover; being compositing, it
// cannot lose stacking to a menu (see Selection.qml, focusdim/contents/code/main.js).
// Not re-told: moving a PlasmaCore.Dialog already in place reconfigures a real window.
let marked = null;

// A panel popup activates a special window (isSpecialWindow()); the hint falls back to `cur`, the last
// non-chrome window, instead of going out.
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
        const n = nodeFor(refOf(w));
        node = n;
        geo = n ? n.data.geo : toGeo(fg(w));
    }
    if (!geo || geo.w <= 0 || geo.h <= 0) { if (marked !== null) { marked = null; ui.hideSelection(); } return; }
    // Sent as is: growing it by a pen width would hand the effect a rect half an inner gap wider than the
    // slot, undimming a neighbour's edge.
    const r = node ? selectionRect(node) : { x: geo.x, y: geo.y, width: geo.w, height: geo.h };
    const key = rectKey(r);
    if (key === marked) return;
    marked = key;
    ui.showSelection(r.x, r.y, r.width, r.height);
}

function onMaximizeChanged(w) {
    batched(() => {
        if (isMaximized(w)) { if (attached(w)) { unmapWindow(w); forget(refOf(w)); } }
        else if (shouldTile(w) && !attached(w)) mapWindow(w, null);
    });
}
function unmaximizeOthers(active) {
    if (!active || !canTile(active)) return;
    const key = keyOf(active);
    for (const w of allWindows()) {
        if (w === active || !canTile(w) || keyOf(w) !== key) continue;
        if (isMaximized(w)) { try { w.setMaximize(false, false); } catch (e) {} }
    }
}

// Popups are ignored here only: dimming acts on the windows, so a menu is simply above them.
function onAdded(w) {
    batched(() => {
        if (DEBUG) log("window added: " + w.resourceClass + " normal=" + w.normalWindow + " tilable=" + isTilable(w));
        try { connectWindow(w); } catch (e) { log("connect error: " + e); }
        if (canTile(w) && isMaximized(w)) { try { w.setMaximize(false, false); } catch (e) {} }
        if (shouldTile(w)) mapWindow(w, null);
    });
    // After the tiler: in unspecified order the trailing empty workspace could be collected out from under
    // a space being laid out.
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
    // KWin still lists a window whose removal it just announced; counting it would keep its workspace alive.
    try { ensureLastEmpty(w); } catch (e) { log("workspace list error: " + e); }
}

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

export function enforceSoon() { if (ui && ui.enforceTimer) ui.enforceTimer.restart(); }
export function reconcile() { batched(reconcileNow); }
function reconcileNow() {
    if (!grabbedNow()) {
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
        // Through unmapRef: the window may be gone, and dropping homeOf while the leaf stays leaves a slot
        // nothing will ever write to.
        try { for (const k of unmapRef(ref)) layout(k); } catch (e) { homeOf.delete(ref); }
        forget(ref);
        windowOf.delete(ref);
    }
    audit();
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

// Invariant: every leaf names an existing window on its space, in exactly one leaf; a breach shows only
// as wallpaper. Repairs are logged whether or not Debug is on.
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

// measure() pushes one rect per size and pops one per child, so a mismatched vector strands children;
// repaired by sharing the length evenly.
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
                // A placeholder with no drag holding it is measured and never written, and no other check sees it.
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
            if (homeOf.get(ref) === key) homeOf.delete(ref);
            forget(ref);
        }
        if (strays.length || repaired) layout(key);
    }

    // Reverse check: a ref homeOf claims that no tree holds is adopted by nothing and laid out by nothing.
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
        if (learnMinimum(ref, w, g, a, sp.area)) dirty.add(key);
        // A window that has not budged since the last pass was already asked to fit; re-asking restarts its
        // geometry animation.
        const now = rectKey(g);
        const budged = lastSeen.get(ref) !== now;
        lastSeen.set(ref, now);
        // Same tolerance as the write path: a window one pixel short of its slot has taken it.
        if (inPlace(g, a)) refused.delete(ref);
        else if (!budged) refused.set(ref, { want: rectKey(a), at: now });
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

// Clients round to character cells and resize asynchronously, so only a clearly larger size counts,
// and only one still too big 1.5s later.
function learnMinimum(ref, w, g, a, area) {
    const known = minimums.get(ref);
    const SLACK = 40;
    const ow = g.width > a.width + SLACK, oh = g.height > a.height + SLACK;
    if (!ow && !oh) {
        overflowSince.delete(ref);
        if (known) {
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

// KWin hands a kcfg Bool back as the string "false", which is truthy; every boolean goes through this.
function cfgBool(key, fallback) {
    const v = kw.readConfig(key, fallback);
    return typeof v === "boolean" ? v : String(v).toLowerCase() === "true";
}
function cfgInt(key, fallback) {
    const v = parseInt(kw.readConfig(key, fallback), 10);
    return Number.isFinite(v) ? v : fallback;
}
// KWin has no signal for its own config changing, and a new script needs a session restart anyway.
function readSettings() {
    if (!kw || typeof kw.readConfig !== "function") return;
    GAP_INNER = cfgInt("GapInner", GAP_INNER);
    GAP_OUTER = cfgInt("GapOuter", GAP_OUTER);
    DEBUG = cfgBool("Debug", DEBUG);
    DROP_PREVIEW = cfgBool("DropPreview", DROP_PREVIEW);
    TAB_BAR = cfgBool("TabBar", TAB_BAR);
    BAR_HEIGHT = cfgInt("BarHeight", BAR_HEIGHT);
    NEW_WORKSPACE_TILED = cfgBool("NewWorkspaceTiled", NEW_WORKSPACE_TILED);
    barH = TAB_BAR ? BAR_HEIGHT : 0;
}

// `reconfigure` does not reach a script but makes KWin drop its cached config, so a later read gets what
// is on disk (measured with a probe script).
function reloadSettings() {
    readSettings();
    inner = GAP_INNER;
    outer = GAP_OUTER;
    // Said again even when unmoved: a freshly loaded outline plugin knows nothing and needs the rect.
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
        // Desktop chrome (panel popup, OSD) taking the keyboard is not a focus change: it would exit the mode
        // and hide the active hint. See focusWindow().
        if (w && w.specialWindow) return;
        if (w && w !== cur) { prev = cur; cur = w; if (mode !== "swap") exitMode(); }
        clearSelection();
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
        desktopSwitched();
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
