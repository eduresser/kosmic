// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// Where the selection is, told to the compositor without drawing anything.
//
// COSMIC marks the focused tile with an outline drawn inside the compositor (`active_hint` in
// cosmic-comp-config, `backend/render/mod.rs:801`), where it sits at the node's own place in the
// stacking order. A KWin script cannot draw there and cannot be stacked there: `belongsToLayer`
// answers `if (isUnmanaged() || isInternal()) return OverlayLayer;` before it looks at a window
// type at all, so every dialog a script builds is above every menu, whatever `type` says. The
// outline that used to live here therefore crossed any menu that opened over it, and the only
// repair available was to stop drawing while one did -- an indicator that blinks out exactly when
// the user is working.
//
// So nothing is drawn. The compositor dims what is *not* selected instead, which is a real
// compositing operation and has no stacking order to lose. That work happens in the focusdim
// effect, and this is how it learns what the selection is: an empty dialog, moved to cover the
// selected rect, which the effect reads by geometry. Two JavaScript engines that cannot call each
// other, with a window between them as the only channel either one can see.
//
// `title` is the channel's name. KWin copies a QWindow's title into the window's caption
// (`internalwindow.cpp:40`), so `caption === "kosmic-selection"` is what the effect matches on --
// explicit, rather than deducing which of our overlays this is from an empty window class.
import QtQuick
import org.kde.plasma.core as PlasmaCore

PlasmaCore.Dialog {
    id: selection

    // What the effect matches. Changing this string means changing it in focusdim's main.js too;
    // there is no third place it could be read from.
    title: "kosmic-selection"

    // Type, flags and background are all inherited reasoning rather than new: the type buys nothing
    // (libplasma rewrites anything but AppletPopup and Tooltip into a Dock as soon as
    // WindowStaysOnTopHint is set, plasmaquick/dialog.cpp:699), and what makes this click-through is
    // NoBackground setting an empty input mask (dialog.cpp:225). It is kept click-through and
    // unfocusable because it is a marker lying over whatever the user is actually using.
    type: PlasmaCore.Dialog.OnScreenDisplay
    flags: Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus
    location: PlasmaCore.Types.Floating
    backgroundHints: PlasmaCore.Dialog.NoBackground
    outputOnly: true
    visible: false

    // Parked, which is how "nothing is selected" is said, and the coordinate is shared: focusdim's
    // PARKED_AT is this number, because a dialog that clamped itself to a minimum size would pass
    // the size test at the other end and dim the whole screen. The effect has no second signal to read:
    // a caption does not change after the window is built (EffectWindow has no caption-changed
    // signal at all), and unmapping would make the window come and go under the effect's feet. A
    // rect this small is one no slot can ever be, and off-screen on top of that, so a reader that
    // somehow missed the size test still finds nothing underneath it.
    readonly property int parkedX: -32000
    readonly property int parkedY: -32000

    // A dialog of this type puts itself in the middle of the screen whenever its size changes, so
    // the asked-for position is kept and put back whenever it drifts. The same thing DropZone.qml
    // does, and for the same reason.
    property int targetX: 0
    property int targetY: 0
    property int targetW: 0
    property int targetH: 0
    readonly property int innerW: Math.max(1, targetW - selection.margins.left - selection.margins.right)
    readonly property int innerH: Math.max(1, targetH - selection.margins.top - selection.margins.bottom)

    function place(x, y, w, h) {
        selection.targetX = x;
        selection.targetY = y;
        selection.targetW = w;
        selection.targetH = h;
        selection.visible = true;
        selection.x = x;
        selection.y = y;
    }

    // Parks rather than unmaps, and that distinction is the whole of this function. The window
    // stays mapped for two reasons: KWin's fadingpopups keeps painting the last frame of a closed
    // OnScreenDisplay for 600ms, and -- the one that matters now -- the effect keys off this
    // window's geometry, so a window that comes and goes is a channel that comes and goes.
    function hide() {
        selection.place(selection.parkedX, selection.parkedY, 1, 1);
    }

    onXChanged: if (selection.visible && selection.x !== selection.targetX) selection.x = selection.targetX;
    onYChanged: if (selection.visible && selection.y !== selection.targetY) selection.y = selection.targetY;
    onInnerWChanged: if (selection.visible) { selection.x = selection.targetX; selection.y = selection.targetY; }
    onInnerHChanged: if (selection.visible) { selection.x = selection.targetX; selection.y = selection.targetY; }

    // Empty on purpose. The marker is geometry and a name; everything visible about the selection
    // is the absence of dimming, drawn by the compositor around it.
    mainItem: Item {
        width: selection.innerW
        height: selection.innerH
    }
}
