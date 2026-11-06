// Compiles rather than instantiates: PlasmoidItem needs the Plasmoid attached object, which only plasmashell has.
// The path is an argument so the caller can name the tree under test (checkout, tarball, installed package).
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
