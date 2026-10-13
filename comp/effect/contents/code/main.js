// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

// Animates frame geometry changes (Hyprland-style: fast start, long soft end).
class TilingGeometryAnimation {
    constructor() {
        effect.configChanged.connect(this.loadConfig.bind(this));
        effects.windowAdded.connect(this.manage.bind(this));
        effects.windowClosed.connect(this.forget.bind(this));
        for (const window of effects.stackingOrder) {
            this.manage(window);
        }
        this.loadConfig();
        // One line per session, always. An effect that says nothing is indistinguishable from an
        // effect that is not loaded, and an hour went into exactly that confusion.
        print("kosmic-anim: loaded, debug=" + this.debug + ", duration=" + this.duration);
    }

    loadConfig() {
        // [Effect-kosmic-tiling-anim] Duration in kwinrc, written by the NixOS module. animationTime
        // still scales it by Plasma's global animation speed, which is a KDE setting and stays one.
        this.duration = animationTime(effect.readConfig("Duration", 350));
        // KWin hands a kcfg Bool back as the string "true" or "false", and "false" is truthy.
        this.debug = String(effect.readConfig("Debug", false)).toLowerCase() === "true";
    }

    // KOSMIC's own overlays -- the active hint, the drop zone, the tab bars -- are
    // PlasmaCore.Dialogs, and the effects API calls them normal windows, so they were animated like
    // any other. The hint then slid and grew across the screen every time it moved, which on a
    // workspace switch is from wherever it was last to the slot it belongs to now: a window
    // appearing to crawl in from the far corner, except it was never the window.
    //
    // They are on-screen displays and they carry no window class, which is two reasons apiece and
    // neither is true of an application.
    isOurs(window) {
        // Trimmed, and that is the whole of the last fix. windowClass is the resource name and the
        // resource class joined by a space, so a window with neither is " " -- one space, which is
        // truthy, so `!window.windowClass` was false for every overlay and the filter never fired.
        // The trace says so and is easy to misread: `animate` followed by three spaces, one of
        // them the class.
        //
        // The class is the branch that matters and the type check is a courtesy: the active hint
        // is a Notification now, not an OnScreenDisplay, so onScreenDisplay is false for it. An
        // empty class is what every window this module opens has in common, because they are all
        // PlasmaCore.Dialogs built inside KWin's own QML engine and no application owns them.
        return window.onScreenDisplay === true ||
            String(window.windowClass || "").trim() === "";
    }

    trace(msg) {
        if (this.debug) {
            print("kosmic-anim: " + msg);
        }
    }

    manage(window) {
        // The filter is NOT applied here. windowAdded arrives before the surface has announced its
        // app id, so windowClass is empty for everything at this moment -- including every real
        // application -- and testing it here silently managed nothing at all. The log went quiet,
        // which is the only reason it was caught: there were no "skip" lines either, and skip is
        // logged from a handler this would never have connected.
        if (!window.normalWindow) {
            return;
        }
        window.windowFrameGeometryChanged.connect(this.onGeometryChanged.bind(this));
        // Nothing may animate while the user is dragging a window: an animation makes it trail the
        // cursor and then jump to catch up. `userMove`, which this used to test, is not part of the
        // effect API and was always undefined -- the built-in translucency effect watches these two
        // signals and the built-in fullscreen effect reads window.resize, so this uses both.
        window.windowStartUserMovedResized.connect(this.onMoveResizeStart.bind(this));
        window.windowFinishUserMovedResized.connect(this.onMoveResizeFinish.bind(this));
    }

    onMoveResizeStart(window) {
        window.tgMoving = true;
        this.forget(window);   // whatever was playing would go on playing into the drag
    }

    onMoveResizeFinish(window) {
        window.tgMoving = false;
    }

    forget(window) {
        if (window.tgAnim) {
            cancel(window.tgAnim);
            delete window.tgAnim;
        }
    }

    onGeometryChanged(window, oldGeometry) {
        const newGeometry = window.geometry;
        const where = (r) => r
            ? Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.width) + "x" + Math.round(r.height)
            : "?";
        const what = (window.windowClass || "?") + " " + where(oldGeometry) + " -> " + where(newGeometry);
        // Here, where the class is known. KOSMIC's own overlays -- the active hint, the drop zone,
        // the tab bars -- are PlasmaCore.Dialogs that the effects API calls normal windows, so they
        // were animated like applications: the hint slid and grew across the screen every time it
        // moved, which on a workspace switch is from wherever it was last to the slot it belongs to
        // now. A window appearing to crawl in from the far corner, except it was never a window.
        if (this.isOurs(window)) {
            this.trace("skip ours " + what);
            return;
        }
        if (!window.visible || window.tgMoving || window.move || window.resize) {
            this.trace("skip " + what + " (visible=" + window.visible + " moving=" + !!window.tgMoving +
                " move=" + window.move + " resize=" + window.resize + ")");
            return;
        }
        // Ignore the first placement of a window and no-op changes.
        if (oldGeometry.width <= 0 || oldGeometry.height <= 0) {
            this.trace("skip first placement " + what);
            return;
        }
        // Not an exact comparison: with fractional display scaling a window is snapped to the device
        // pixel grid, so re-applying the geometry it already has still counts as a change. Animating
        // those is what makes a window flicker while the layout is being recalculated.
        if (Math.abs(oldGeometry.x - newGeometry.x) < 1 && Math.abs(oldGeometry.y - newGeometry.y) < 1 &&
            Math.abs(oldGeometry.width - newGeometry.width) < 1 && Math.abs(oldGeometry.height - newGeometry.height) < 1) {
            return;
        }
        this.trace("animate " + what);
        if (window.tgAnim) {
            cancel(window.tgAnim);
            delete window.tgAnim;
        }
        window.tgAnim = animate({
            window: window,
            duration: this.duration,
            animations: [{
                type: Effect.Size,
                from: { value1: oldGeometry.width, value2: oldGeometry.height },
                to: { value1: newGeometry.width, value2: newGeometry.height },
                curve: QEasingCurve.OutQuint
            }, {
                type: Effect.Translation,
                from: {
                    value1: oldGeometry.x - newGeometry.x - (newGeometry.width / 2 - oldGeometry.width / 2),
                    value2: oldGeometry.y - newGeometry.y - (newGeometry.height / 2 - oldGeometry.height / 2)
                },
                to: { value1: 0, value2: 0 },
                curve: QEasingCurve.OutQuint
            }, {
                type: Effect.CrossFadePrevious,
                from: 0.0,
                to: 1.0,
                curve: QEasingCurve.OutQuint
            }]
        });
    }
}

new TilingGeometryAnimation();
