// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// Does the panel applet's QML parse, and are its imports present?
//
// Same question components.qml asks of the overlays, asked of the plasmoid. It compiles the
// component rather than instantiating it: PlasmoidItem needs the Plasmoid attached object, which
// exists only inside plasmashell, so creating one here would fail for a reason that says nothing
// about the file. Compiling is what catches the failures worth catching before a login -- a syntax
// error, or an import that is not installed -- either of which leaves a blank square in the panel
// and a single line in the journal.
//
// The path is passed rather than found, for the reason the keymap is passed to the sims: the flake
// check puts comp/ in the store on its own, and `../../../applet` from here would walk out of the
// store entirely. Run from a checkout with no argument, the relative path is still right.
import QtQuick
import QtQml

QtObject {
    readonly property string path: {
        const args = Qt.application.arguments
        const last = args.length ? String(args[args.length - 1]) : ""
        return last.indexOf("main.qml") >= 0 ? last : "../../../applet/contents/ui/main.qml"
    }
    property var applet: Qt.createComponent(path)

    Component.onCompleted: {
        var bad = [];
        if (applet.status !== Component.Ready) bad.push(path + ": " + applet.errorString());

        if (bad.length) {
            console.warn("QML APPLET FAILED: " + bad.join(" | "));
            Qt.exit(1);
        } else {
            console.warn("qml applet ok");
            Qt.exit(0);
        }
    }
}
