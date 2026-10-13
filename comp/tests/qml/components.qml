// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// Do the overlays the script creates at run time actually build, and does hiding one keep it mapped?
//
// They are QML components loaded with Qt.createComponent, which fails at run time and returns null
// rather than failing at build. The script then logs one line and carries on without the thing it
// was about to draw -- a drop preview that never appears, a selection the compositor never hears
// about -- which looks like the feature not being implemented rather than being broken. This is the
// same question load.qml asks of the JavaScript, for the part of the module that is not JavaScript.
//
// The second question is about the selection marker, and it has two halves that nothing in the
// source states. The marker is how the focusdim effect learns what is selected: an empty window the
// tiler moves over the selected rect, read back by geometry and matched by caption. So its title is
// a wire format -- change it here and the effect stops finding it, with no error anywhere -- and
// hide() has to park the window rather than unmap it, because a channel that comes and goes is a
// channel the reader has to guess about. (Unmapping has a second cost that predates this: KWin's
// fadingpopups keeps painting a closed OnScreenDisplay for 600ms, which is how the old outline
// survived a whole workspace switch, pointing at a window that was no longer there.)
//
// main.qml itself cannot be checked here: it imports org.kde.kwin, which only exists inside KWin.
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
                // The name the effect matches on. focusdim/contents/code/main.js has the same
                // string in MARKER, and there is no third place either of them could read it from.
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

            // The other two are named as well, because focusdim tells our overlays apart by
            // caption: all three carry an empty window class and nothing else separates them.
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
