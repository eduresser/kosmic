// KWin's Workspace.showOutline opens a new window on every call and flashes; this one dialog is moved instead.
import QtQuick
import org.kde.plasma.core as PlasmaCore
import org.kde.kirigami as Kirigami

PlasmaCore.Dialog {
    id: zone

    // Named so the focusdim effect leaves it undimmed; see TabBar.qml for why the name and not the class.
    title: "kosmic-dropzone"

    type: PlasmaCore.Dialog.OnScreenDisplay
    flags: Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus
    location: PlasmaCore.Types.Floating
    // The theme's own dialog background, which is what carries the blur -- the same thing behind the
    // panel. NoBackground draws nothing, so there is no region for the blur effect to work on.
    backgroundHints: PlasmaCore.Dialog.StandardBackground
    outputOnly: true
    visible: false

    // A dialog of this type recentres itself when its size changes, so the asked-for position is put back
    // whenever it drifts.
    property int targetX: 0
    property int targetY: 0
    property int targetW: 0
    property int targetH: 0
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
