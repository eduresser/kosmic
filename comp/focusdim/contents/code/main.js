// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

// What is selected, said by dimming everything that is not.
//
// COSMIC draws an outline around the focused tile, inside the compositor, where it sits at the
// node's own place in the stacking order (`active_hint`, backend/render/mod.rs :801). A KWin script
// cannot put a line there: every window it opens is an internal window, and belongsToLayer answers
// `if (isUnmanaged() || isInternal()) return OverlayLayer;` before it looks at a window type at
// all, so the line was above every menu that opened under it. The repair available from the script
// side was to stop drawing while a menu covered it -- an indicator that blinks out exactly when the
// user is working. This is the other way round: the windows themselves are dimmed, which is a
// compositing operation on real windows, so a menu is simply above them and nothing has to know it
// opened.
//
// It has to follow the *selection* and not the active window, which is why KWin's own diminactive
// cannot do this job. Focus(Out) selects the group around the focused window without changing which
// window is active, and the next resize or move applies to that whole group. diminactive
// reads effects.activeWindow and would light exactly one window of it.
//
// The selection lives in the tiler, which runs in a different JavaScript engine with no way to call
// this one. The channel between them is a window: contents/ui/Selection.qml is an empty dialog the
// tiler moves over the selected rect, named "kosmic-selection" in its title, which KWin copies into
// the window's caption (internalwindow.cpp :40). This reads it by geometry.

const MARKER = "kosmic-selection";
const TABBAR = "kosmic-tabbar";
const DROPZONE = "kosmic-dropzone";

// Parked means "nothing is selected"; see Selection.qml for why the marker parks rather than
// unmapping. Two tests, because getting this wrong is the one failure that matters: a marker read
// as a selection when it is not covers no window at all, and every window on the screen goes dark.
//
// Size is the first. Anything this small is the signal and not a slot -- the smallest slot a layout
// can hand out is a window's minimum size.
//
// Position is the second, and it is here because the first one is not ours to guarantee. The marker
// is a PlasmaCore.Dialog and a dialog may clamp itself to a minimum size; if it ever did, a parked
// marker would pass the size test and dim the screen. PARKED_AT is Selection.qml's own parked
// coordinate -- the one number this file and that one both have to know, which is why both say so.
const PARKED = 8;
const PARKED_AT = -32000;

class FocusDim {
    constructor() {
        this.marker = null;
        effect.configChanged.connect(this.reconfigure.bind(this));
        effects.windowAdded.connect(this.onAdded.bind(this));
        effects.windowClosed.connect(this.onClosed.bind(this));
        effects.desktopChanged.connect(this.refresh.bind(this));
        // Inhibitors, both of which are somebody else drawing the screen: the overview and the grid
        // are full screen effects painting every window as a thumbnail, and half of them dimmed
        // there is noise rather than information; a colour picker needs the colour that is actually
        // on the screen. dialogparent inhibits on the same two, and this is ordered after it so the
        // full screen effect has already marked itself by the time the signal arrives.
        effects.hasActiveFullScreenEffectChanged.connect(this.refresh.bind(this));
        effects.colorPickerActiveChanged.connect(this.refresh.bind(this));
        for (const window of effects.stackingOrder) {
            this.manage(window);
        }
        this.loadConfig();
        // One line per session, always. An effect that says nothing is indistinguishable from an
        // effect that is not loaded -- the same lesson the geometry animation records.
        print("kosmic-focusdim: loaded, strength=" + this.strength + ", duration=" + this.duration +
              ", debug=" + this.debug);
        this.refresh();
    }

    loadConfig() {
        // [Effect-kosmic-focusdim] in kwinrc, set from its own dialog. One number for both
        // attributes: brightness carries the dimming and saturation follows it at half the rate,
        // because colour draining faster than light reads as a fault rather than as "not here".
        this.strength = Math.max(0, Math.min(100, effect.readConfig("Strength", 30)));
        this.brightness = 1 - this.strength / 100;
        this.saturation = 1 - this.strength / 200;
        // animationTime still scales this by Plasma's global animation speed, which is a KDE
        // setting and stays one. Deliberately shorter than the geometry animation: the selection
        // should arrive before the layout has finished settling under it.
        this.duration = animationTime(effect.readConfig("Duration", 250));
        // KWin hands a kcfg Bool back as the string "true" or "false", and "false" is truthy.
        this.debug = String(effect.readConfig("Debug", false)).toLowerCase() === "true";
    }

    // Reached by `qdbus org.kde.KWin /Effects org.kde.kwin.Effects.reconfigureEffect kosmic-focusdim`
    // and NOT by `qdbus org.kde.KWin /KWin reconfigure`. Measured rather than assumed, after the second
    // one was written into the option description and silently did nothing: `reconfigureEffects()`
    // is connected only to `Options::animationSpeedChanged` (effecthandler.cpp :159), so the global
    // reconfigure reaches scripts and leaves every effect on the config it loaded with.
    reconfigure() {
        this.loadConfig();
        // The old numbers are baked into every running animation, so they are torn down rather than
        // redirected. Instant, because a strength being tuned by hand is being watched.
        for (const window of effects.stackingOrder) {
            this.release(window);
        }
        this.refresh();
    }

    trace(msg) {
        if (this.debug) {
            print("kosmic-focusdim: " + msg);
        }
    }

    // ---- the channel ----

    manage(window) {
        if (String(window.caption) === MARKER) {
            this.marker = window;
        }
        // Geometry is how the marker speaks, and also how a window moves in or out of the half of
        // its own area that keeps it lit, so both are the same signal. The rest are the states that
        // take a window out of the dimmable set without moving it.
        window.windowFrameGeometryChanged.connect(this.refresh.bind(this));
        window.windowDesktopsChanged.connect(this.refresh.bind(this));
        window.minimizedChanged.connect(this.refresh.bind(this));
        window.windowFullScreenChanged.connect(this.refresh.bind(this));
        window.windowHiddenChanged.connect(this.refresh.bind(this));
    }

    onAdded(window) {
        this.manage(window);
        this.refresh();
    }

    onClosed(window) {
        if (window === this.marker) {
            // The failsafe, and the only part of this file that is not cosmetic. A `set` animation
            // holds its end value for as long as the window lives, so a tiler that has gone away --
            // crashed, unloaded, logged out of -- would otherwise leave the screen dark with nothing
            // left running that could undo it. No marker is no selection, and no selection lights
            // everything back up.
            this.marker = null;
            this.trace("marker closed: lighting everything back up");
        }
        this.release(window);
        this.refresh();
    }

    // The selected rect, or null for "nothing is selected" -- which includes every way the channel
    // can fail, because a reader that cannot find the marker must light the screen rather than dim it.
    selection() {
        let m = this.marker;
        if (!m || m.deleted) {
            m = null;
            for (const window of effects.stackingOrder) {
                if (!window.deleted && String(window.caption) === MARKER) {
                    m = window;
                    break;
                }
            }
            this.marker = m;
        }
        if (!m) {
            return null;
        }
        const g = m.geometry;
        if (!g || g.width <= PARKED || g.height <= PARKED) {
            return null;
        }
        if (g.x <= PARKED_AT || g.y <= PARKED_AT) {
            return null;
        }
        return g;
    }

    // ---- who dims ----

    dimmable(window) {
        if (!window || window.deleted || !window.visible || window.minimized) {
            return false;
        }
        const caption = String(window.caption);
        // Our own overlays, by name rather than by window class. All three carry an empty class --
        // they are PlasmaCore.Dialogs built inside a KWin script's QML engine and no application
        // owns them -- so the class cannot tell them apart. The marker is the thing being read and
        // the drop zone is already saying where a window is going; a tab bar is the top of the slot
        // under it and dims with it.
        if (caption === MARKER || caption === DROPZONE) {
            return false;
        }
        if (caption === TABBAR) {
            return true;
        }
        if (!window.normalWindow) {
            return false;
        }
        // The panel, the desktop, menus and notifications are not part of the layout and are not
        // what the selection is about. A menu dimmed with the window that opened it is the exact
        // thing this effect exists to stop happening.
        if (window.popupWindow || window.dock || window.desktopWindow || window.onScreenDisplay ||
            window.notification || window.criticalNotification || window.dndIcon || window.lockScreen) {
            return false;
        }
        return window.onCurrentDesktop;
    }

    // A second monitor stays lit. The selection lives on one output, so every window on the other
    // one has no overlap with it at all and the rule below would dim the whole screen -- which is
    // the screen the user is reading while they work on this one.
    sameScreen(window, screen) {
        try {
            return !screen || !window.screen || window.screen.name === screen.name;
        } catch (e) {
            return true;
        }
    }

    // Half of the window's *own* area inside the selection, not containment and not intersection.
    // Containment fails the case selectionRect() in the tiler exists for: a client that refused its
    // size is drawn outside the slot it was given, so the selected window itself is not contained.
    // Intersection fails the other end of the same case -- the neighbour it spilled over intersects
    // too, and both would stay lit. Measuring against the window's own area separates them: the one
    // that spilled is almost entirely inside, the one it landed on has a strip.
    inside(g, sel) {
        if (!g || g.width <= 0 || g.height <= 0) {
            return false;
        }
        const w = Math.min(g.x + g.width, sel.x + sel.width) - Math.max(g.x, sel.x);
        const h = Math.min(g.y + g.height, sel.y + sel.height) - Math.max(g.y, sel.y);
        if (w <= 0 || h <= 0) {
            return false;
        }
        return (w * h) * 2 >= g.width * g.height;
    }

    // A full screen window is the whole output, so there is nothing beside it to dim and the dimming
    // would land on the thing being watched. Only on the selection's own screen: full screen video
    // on one monitor does not disable the indicator on the other.
    fullScreenOver(screen) {
        for (const window of effects.stackingOrder) {
            if (window.deleted || !window.visible || window.minimized || !window.fullScreen) {
                continue;
            }
            if (window.onCurrentDesktop && this.sameScreen(window, screen)) {
                return true;
            }
        }
        return false;
    }

    refresh() {
        const sel = this.selection();
        const screen = this.marker && !this.marker.deleted ? this.marker.screen : null;
        const off = !sel || effects.hasActiveFullScreenEffect || effects.colorPickerActive ||
            this.fullScreenOver(screen);
        for (const window of effects.stackingOrder) {
            const dim = !off && this.dimmable(window) && this.sameScreen(window, screen) &&
                !this.inside(window.geometry, sel);
            this.apply(window, dim);
        }
    }

    // ---- the animation ----

    // The state guard. refresh() runs on every geometry write the tiler makes -- one per window per
    // layout pass, and that again on every pass of the correction loop -- so without this, a settled
    // screen still costs a redirect call per window per refresh. Not a visible fault: redirecting an
    // animation that is already going the right way is a no-op on the screen, which is exactly why
    // the cost would never show up as a bug. sim30 counts the redirects for that reason.
    apply(window, dim) {
        if (window.kfdDimmed === dim) {
            return;
        }
        window.kfdDimmed = dim;
        this.trace((dim ? "dim " : "light ") + (window.caption || window.windowClass || "?"));
        if (dim) {
            this.dim(window);
        } else {
            this.light(window);
        }
    }

    dim(window) {
        if (window.kfdAnim !== undefined) {
            if (redirect(window.kfdAnim, Effect.Forward)) {
                return;
            }
            cancel(window.kfdAnim);
            delete window.kfdAnim;
        }
        // The shape dialogparent uses, which is the in-tree precedent for dimming a window from a
        // scripted effect: `set` rather than `animate`, so the end value is held for as long as the
        // window is not selected, and keepAlive false so a window closing while dimmed is not kept
        // on the screen by its own animation.
        window.kfdAnim = set({
            window: window,
            duration: this.duration,
            keepAlive: false,
            animations: [{
                type: Effect.Saturation,
                to: this.saturation,
                curve: QEasingCurve.InOutQuad
            }, {
                type: Effect.Brightness,
                to: this.brightness,
                curve: QEasingCurve.InOutQuad
            }]
        });
    }

    light(window) {
        if (window.kfdAnim === undefined) {
            return;
        }
        // Played backwards rather than cancelled, so a window being selected fades up over the same
        // duration it faded down. The handle is kept: redirecting it forward again is what dims it
        // next time, which is cheaper than tearing the animation down and building another.
        if (redirect(window.kfdAnim, Effect.Backward)) {
            return;
        }
        cancel(window.kfdAnim);
        delete window.kfdAnim;
    }

    // Instant and complete: the window goes back to its own colours and forgets it was ever dimmed.
    release(window) {
        if (window.kfdAnim !== undefined) {
            cancel(window.kfdAnim);
            delete window.kfdAnim;
        }
        delete window.kfdDimmed;
    }
}

new FocusDim();
