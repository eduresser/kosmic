"use strict";

class TilingGeometryAnimation {
    constructor() {
        effect.configChanged.connect(this.loadConfig.bind(this));
        effects.windowAdded.connect(this.manage.bind(this));
        effects.windowClosed.connect(this.forget.bind(this));
        for (const window of effects.stackingOrder) {
            this.manage(window);
        }
        this.loadConfig();
        print("kosmic-anim: loaded, debug=" + this.debug + ", duration=" + this.duration);
    }

    loadConfig() {
        this.duration = animationTime(effect.readConfig("Duration", 350));
        // KWin hands a kcfg Bool back as the string "true" or "false", and "false" is truthy.
        this.debug = String(effect.readConfig("Debug", false)).toLowerCase() === "true";
    }

    // KOSMIC's overlays (active hint, drop zone, tab bars) are PlasmaCore.Dialogs that the effects API
    // calls normal windows; animating them makes the hint crawl across the screen on workspace switches.
    isOurs(window) {
        // windowClass joins resource name and class with a space, so a classless overlay is " " (truthy):
        // trim first. Overlays have an empty class: PlasmaCore.Dialogs built in KWin's own QML engine.
        return window.onScreenDisplay === true ||
            String(window.windowClass || "").trim() === "";
    }

    trace(msg) {
        if (this.debug) {
            print("kosmic-anim: " + msg);
        }
    }

    manage(window) {
        // Not filtered here: windowAdded fires before the app id arrives, so windowClass is empty for
        // every window, real applications included.
        if (!window.normalWindow) {
            return;
        }
        window.windowFrameGeometryChanged.connect(this.onGeometryChanged.bind(this));
        // `userMove` is not part of the effect API (always undefined); the built-in translucency effect
        // watches these two signals and the fullscreen effect reads window.resize.
        window.windowStartUserMovedResized.connect(this.onMoveResizeStart.bind(this));
        window.windowFinishUserMovedResized.connect(this.onMoveResizeFinish.bind(this));
    }

    onMoveResizeStart(window) {
        window.tgMoving = true;
        this.forget(window);
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
        if (this.isOurs(window)) {
            this.trace("skip ours " + what);
            return;
        }
        if (!window.visible || window.tgMoving || window.move || window.resize) {
            this.trace("skip " + what + " (visible=" + window.visible + " moving=" + !!window.tgMoving +
                " move=" + window.move + " resize=" + window.resize + ")");
            return;
        }
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
