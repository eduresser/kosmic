// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// The square that marks where a dragged window would land. KWin's own outline (Workspace.showOutline)
// opens a new window on every call -- visible in the journal as a window added after each one -- so it
// flashes rather than staying put. This is one window that is moved instead, the same PlasmaCore.Dialog
// the tab bar uses, and it stays on the screen for as long as the drag lasts.
import QtQuick
import org.kde.plasma.core as PlasmaCore
import org.kde.kirigami as Kirigami

PlasmaCore.Dialog {
    id: zone

    // Named for the focusdim effect, which leaves it alone: it is already saying where a window is
    // going, and dimming it would argue with that. See TabBar.qml for why the name and not the class.
    title: "kosmic-dropzone"

    type: PlasmaCore.Dialog.OnScreenDisplay
    flags: Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus
    location: PlasmaCore.Types.Floating
    // The theme's own dialog background, which is what carries the blur -- the same thing behind the
    // panel. NoBackground draws nothing, so there is no region for the blur effect to work on.
    backgroundHints: PlasmaCore.Dialog.StandardBackground
    outputOnly: true           // it marks a place; it is not something to click
    visible: false

    // Where the square is wanted. A dialog of this type places itself in the middle of the screen when
    // its size changes, so the asked-for position is kept and put back whenever it drifts -- otherwise
    // the square starts the drag in the centre instead of over the window it stands for.
    property int targetX: 0
    property int targetY: 0
    property int targetW: 0
    property int targetH: 0
    // The dialog is the background plus its margins, so the inner item is the slot less those margins:
    // what the user sees then lines up with the slot the window will get.
    readonly property int innerW: Math.max(1, targetW - zone.margins.left - zone.margins.right)
    readonly property int innerH: Math.max(1, targetH - zone.margins.top - zone.margins.bottom)

    function place(x, y, w, h) {
        zone.targetX = x;
        zone.targetY = y;
        zone.targetW = w;
        zone.targetH = h;
        zone.visible = true;
        zone.x = x;
        zone.y = y;
    }

    onXChanged: if (zone.visible && zone.x !== zone.targetX) zone.x = zone.targetX;
    onYChanged: if (zone.visible && zone.y !== zone.targetY) zone.y = zone.targetY;
    onInnerWChanged: if (zone.visible) { zone.x = zone.targetX; zone.y = zone.targetY; }
    onInnerHChanged: if (zone.visible) { zone.x = zone.targetX; zone.y = zone.targetY; }

    mainItem: Item {
        width: zone.innerW
        height: zone.innerH

        // A wash of the accent colour over the blurred background, and an edge to read the slot by.
        Rectangle {
            anchors.fill: parent
            color: Kirigami.Theme.highlightColor
            opacity: 0.2
        }
        Rectangle {
            anchors.fill: parent
            color: "transparent"
            border.color: Kirigami.Theme.highlightColor
            border.width: 2
        }
    }
}
