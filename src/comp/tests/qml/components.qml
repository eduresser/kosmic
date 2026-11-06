// Qt.createComponent fails silently at run time, so each overlay is built here. The marker title is a wire
// format focusdim matches on, and hide() must park rather than unmap it or the effect loses the channel.
import QtQuick
import QtQml

QtObject {
    property var selection: Qt.createComponent("../../script/contents/ui/Selection.qml")
    property var zone: Qt.createComponent("../../script/contents/ui/DropZone.qml")
    property var bar: Qt.createComponent("../../script/contents/ui/TabBar.qml")

    Component.onCompleted: {
        var bad = [];
        if (selection.status !== Component.Ready) bad.push("Selection.qml: " + selection.errorString());
        if (zone.status !== Component.Ready) bad.push("DropZone.qml: " + zone.errorString());
        if (bar.status !== Component.Ready) bad.push("TabBar.qml: " + bar.errorString());

        if (!bad.length) {
            var s = selection.createObject(null);
            if (!s) {
                bad.push("Selection.qml: createObject returned null");
            } else {
                // focusdim/contents/code/main.js holds the same string in MARKER.
                if (s.title !== "kosmic-selection") bad.push("the marker is not named kosmic-selection: " + s.title);

                s.place(100, 200, 400, 300);
                if (!s.visible) bad.push("place() left the marker unmapped");
                if (s.targetX !== 100 || s.targetY !== 200 || s.targetW !== 400 || s.targetH !== 300)
                    bad.push("place() did not keep the rect it was given");

                s.hide();
                if (!s.visible) bad.push("hide() unmapped the marker: the effect loses the channel");
                if (s.targetW > 8 || s.targetH > 8)
                    bad.push("hide() left the marker large enough to read as a selection: " +
                             s.targetW + "x" + s.targetH);
                s.destroy();
            }

            // focusdim tells our overlays apart only by caption; all three have an empty window class.
            var z = zone.createObject(null);
            if (!z) {
                bad.push("DropZone.qml: createObject returned null");
            } else {
                if (z.title !== "kosmic-dropzone") bad.push("the drop zone is not named kosmic-dropzone: " + z.title);
                z.destroy();
            }
            var b = bar.createObject(null);
            if (!b) {
                bad.push("TabBar.qml: createObject returned null");
            } else {
                if (b.title !== "kosmic-tabbar") bad.push("the tab bar is not named kosmic-tabbar: " + b.title);
                b.destroy();
            }
        }

        if (bad.length) {
            console.warn("QML COMPONENTS FAILED: " + bad.join(" | "));
            Qt.exit(1);
        } else {
            console.warn("qml components ok");
            Qt.exit(0);
        }
    }
}
