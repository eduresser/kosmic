"use strict";

// Selection reaches this engine as a window: Selection.qml's empty dialog, titled "kosmic-selection"
// (copied into the caption, internalwindow.cpp :40), is moved over the selected rect by the tiler.

// Dims by selection, not the active window: Focus(Out) selects a group without changing which window
// is active, and diminactive (effects.activeWindow) would light only one window of it.

const MARKER = "kosmic-selection";
const TABBAR = "kosmic-tabbar";
const DROPZONE = "kosmic-dropzone";

// Parked means nothing is selected. Tested by size and by PARKED_AT (Selection.qml's parked
// coordinate): a parked marker read as a selection covers no window and the whole screen goes dark.
const PARKED = 8;
const PARKED_AT = -32000;

class FocusDim {
    constructor() {
        this.marker = null;
        effect.configChanged.connect(this.reconfigure.bind(this));
        effects.windowAdded.connect(this.onAdded.bind(this));
        effects.windowClosed.connect(this.onClosed.bind(this));
        effects.desktopChanged.connect(this.refresh.bind(this));
        // Inhibited while full screen effects (overview, grid) or a colour picker draw the screen. Ordered
        // after dialogparent, so the full screen effect has marked itself when the signal arrives.
        effects.hasActiveFullScreenEffectChanged.connect(this.refresh.bind(this));
        effects.colorPickerActiveChanged.connect(this.refresh.bind(this));
        for (const window of effects.stackingOrder) {
            this.manage(window);
        }
        this.loadConfig();
        print("kosmic-focusdim: loaded, strength=" + this.strength + ", duration=" + this.duration +
              ", debug=" + this.debug);
        this.refresh();
    }

    loadConfig() {
        // brightness carries the dimming and saturation follows at half rate: colour draining faster than
        // light reads as a fault.
        this.strength = Math.max(0, Math.min(100, effect.readConfig("Strength", 30)));
        this.brightness = 1 - this.strength / 100;
        this.saturation = 1 - this.strength / 200;
        this.duration = animationTime(effect.readConfig("Duration", 250));
        // KWin hands a kcfg Bool back as the string "true" or "false", and "false" is truthy.
        this.debug = String(effect.readConfig("Debug", false)).toLowerCase() === "true";
    }

    // Reached by `qdbus org.kde.KWin /Effects org.kde.kwin.Effects.reconfigureEffect kosmic-focusdim`,
    // not `/KWin reconfigure`: that reaches scripts only (effecthandler.cpp :159).
    reconfigure() {
        this.loadConfig();
        // The old numbers are baked into every running animation, so tear down rather than redirect.
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

    manage(window) {
        if (String(window.caption) === MARKER) {
            this.marker = window;
        }
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
            // Failsafe: a `set` animation holds its end value for the window's life, so with no marker
            // (tiler gone) everything must light back up.
            this.marker = null;
            this.trace("marker closed: lighting everything back up");
        }
        this.release(window);
        this.refresh();
    }

    // null on every channel failure: an unreadable marker must light the screen, not dim it.
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

    dimmable(window) {
        if (!window || window.deleted || !window.visible || window.minimized) {
            return false;
        }
        const caption = String(window.caption);
        // Own overlays by name: all have an empty class, so the class cannot tell them apart.
        if (caption === MARKER || caption === DROPZONE) {
            return false;
        }
        if (caption === TABBAR) {
            return true;
        }
        if (!window.normalWindow) {
            return false;
        }
        // A menu dimmed with the window that opened it is what this effect exists to prevent.
        if (window.popupWindow || window.dock || window.desktopWindow || window.onScreenDisplay ||
            window.notification || window.criticalNotification || window.dndIcon || window.lockScreen) {
            return false;
        }
        return window.onCurrentDesktop;
    }

    // Other outputs stay lit: they have no overlap with the selection and would all be dimmed.
    sameScreen(window, screen) {
        try {
            return !screen || !window.screen || window.screen.name === screen.name;
        } catch (e) {
            return true;
        }
    }

    // Half of the window's own area, not containment or intersection: a client that refused its size
    // spills over its slot, and both it and the neighbour it landed on would stay lit otherwise.
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

    // State guard: refresh() runs per geometry write, so without it a settled screen still costs a
    // redirect call per window.
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
        // Same shape as dialogparent: `set` holds the end value; keepAlive false so a window closing while
        // dimmed is not kept on screen by its animation.
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
        // Played backwards, not cancelled, so the fade up matches the fade down; the handle is reused
        // when dimming again.
        if (redirect(window.kfdAnim, Effect.Backward)) {
            return;
        }
        cancel(window.kfdAnim);
        delete window.kfdAnim;
    }

    release(window) {
        if (window.kfdAnim !== undefined) {
            cancel(window.kfdAnim);
            delete window.kfdAnim;
        }
        delete window.kfdDimmed;
    }
}

new FocusDim();
