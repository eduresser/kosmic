// Tells the focusdim effect where the selection is: an empty dialog moved over the selected rect, read by geometry.
// Nothing is drawn because script dialogs always stack above menus (KWin belongsToLayer returns OverlayLayer).
import QtQuick
import org.kde.plasma.core as PlasmaCore

PlasmaCore.Dialog {
    id: selection

    // Matched by focusdim's main.js (caption === "kosmic-selection"); change both together.
    title: "kosmic-selection"

    // libplasma rewrites any type but AppletPopup/Tooltip into a Dock once WindowStaysOnTopHint is set (dialog.cpp:699);
    // NoBackground's empty input mask is what makes it click-through (dialog.cpp:225).
    type: PlasmaCore.Dialog.OnScreenDisplay
    flags: Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus
    location: PlasmaCore.Types.Floating
    backgroundHints: PlasmaCore.Dialog.NoBackground
    outputOnly: true
    visible: false

    // Parked means nothing selected; focusdim's PARKED_AT must equal this. A caption never changes after build,
    // and unmapping would make the channel come and go.
    readonly property int parkedX: -32000
    readonly property int parkedY: -32000

    // Same recentring workaround as DropZone.qml.
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

    // Parks instead of unmapping: fadingpopups repaints a closed OSD for 600ms, and the effect reads this geometry.
    function hide() {
        selection.place(selection.parkedX, selection.parkedY, 1, 1);
    }

    onXChanged: if (selection.visible && selection.x !== selection.targetX) selection.x = selection.targetX;
    onYChanged: if (selection.visible && selection.y !== selection.targetY) selection.y = selection.targetY;
    onInnerWChanged: if (selection.visible) { selection.x = selection.targetX; selection.y = selection.targetY; }
    onInnerHChanged: if (selection.visible) { selection.x = selection.targetX; selection.y = selection.targetY; }

    mainItem: Item {
        width: selection.innerW
        height: selection.innerH
    }
}
