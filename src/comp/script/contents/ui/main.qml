import QtQuick
import QtQml.Models
import org.kde.kwin

import "../code/kosmic-tiling.mjs" as Kosmic
import "../code/keymap.mjs" as Keymap

Item {
    id: root
    // A modal shortcut binds only while its mode is active (resize shares Meta+Left with focus).
    property string activeMode: ""
    // Shortcuts are registered a few seconds after the script starts: at login KWin loads scripts before the
    // global shortcut daemon is ready, and keys registered that early are silently never delivered.
    property bool keysReady: false


    Timer {
        interval: 4000
        running: true
        repeat: false
        onTriggered: root.keysReady = true
    }

    // With chordhold on, the chord belongs to the plugin, which sits after InputFilterOrder::GlobalShortcut: a normal
    // shortcut would match first and fire alongside it. So the toggles register an unpressable placeholder instead.
    property bool chordHold: String(KWin.readConfig("ChordHold", "false")).toLowerCase() === "true"
    function sequenceFor(name, chord) {
        if (root.chordHold && Keymap.SUPERSEDED[name] !== undefined) return Keymap.SUPERSEDED[name];
        return chord;
    }

    Instantiator {
        active: root.keysReady
        model: Keymap.KEYS
        delegate: ShortcutHandler {
            required property var modelData
            name: modelData[0]
            text: modelData[1]
            sequence: root.sequenceFor(modelData[0], modelData[2])
            onActivated: { try { Kosmic.action(modelData[4]); } catch (e) { root.dbg("action error: " + e + " @ " + e.stack); } }
        }
    }

    function dbg(msg) { console.log("kosmic-tiling: " + msg); }

    property Component zoneComponent: Qt.createComponent(Qt.resolvedUrl("DropZone.qml"))
    property var zoneItem: null
    function showZone(x, y, w, h) {
        if (!zoneItem) {
            if (!zoneComponent || zoneComponent.status !== Component.Ready) {
                root.dbg("drop zone unavailable: " + (zoneComponent ? zoneComponent.errorString() : "no component"));
                return false;
            }
            zoneItem = zoneComponent.createObject(root);
            if (!zoneItem) return false;
        }
        zoneItem.place(x, y, w, h);
        return true;
    }
    function hideZone() { if (zoneItem) zoneItem.visible = false; }

    // The plugin takes a D-Bus call; the focusdim effect cannot, and can only read a window, hence the marker below.
    DBusCall {
        id: selectionCall
        service: "org.kde.KWin"
        // Registered on the connection KWin holds this name on, so it reaches the plugin in-process (outline.cpp).
        path: "/kosmic/Selection"
        dbusInterface: "io.github.eduresser.kosmic.Selection"
        method: "SetSelection"
    }
    // One string, not four numbers: DBusCall sends int or double depending on the engine, and a signature mismatch fails silently.
    function publishSelection(rect) {
        selectionCall.arguments = [rect];
        selectionCall.call();
    }

    // A script window is always Normal to the Overview (internalwindow.cpp:154), so it is built only where focusdim needs it.
    property bool selectionMarker: String(KWin.readConfig("SelectionMarker", "true")).toLowerCase() === "true"
    property Component selectionComponent: null
    property var selectionItem: null
    function showSelection(x, y, w, h) {
        root.publishSelection(x + "," + y + "," + w + "," + h);
        if (!root.selectionMarker) return true;
        if (!selectionItem) {
            if (!selectionComponent) selectionComponent = Qt.createComponent(Qt.resolvedUrl("Selection.qml"));
            if (!selectionComponent || selectionComponent.status !== Component.Ready) {
                root.dbg("selection marker unavailable: " + (selectionComponent ? selectionComponent.errorString() : "no component"));
                return false;
            }
            selectionItem = selectionComponent.createObject(root);
            if (!selectionItem) return false;
        }
        selectionItem.place(x, y, w, h);
        return true;
    }
    // Parked, not unmapped (see Selection.qml); the plugin reads "" as nothing selected.
    function hideSelection() {
        root.publishSelection("");
        if (selectionItem) selectionItem.hide();
    }

    property Component barComponent: Qt.createComponent(Qt.resolvedUrl("TabBar.qml"))
    function newBar() {
        if (!barComponent || barComponent.status !== Component.Ready) {
            root.dbg("tab bar unavailable: " + (barComponent ? barComponent.errorString() : "no component"));
            return null;
        }
        var o = barComponent.createObject(root);
        if (!o) return null;
        o.tabActivated.connect(function (id, i) { try { Kosmic.tabActivate(id, i); } catch (e) { root.dbg("tab activate: " + e); } });
        o.tabClosed.connect(function (id, i) { try { Kosmic.tabClose(id, i); } catch (e) { root.dbg("tab close: " + e); } });
        return o;
    }

    property bool osdEnabled: String(KWin.readConfig("StackOsd", "false")).toLowerCase() === "true"
    DBusCall {
        id: osdCall
        service: "org.kde.plasmashell"
        path: "/org/kde/osdService"
        dbusInterface: "org.kde.osdService"
        method: "showText"
    }
    // Pushed because a KWin script registers no D-Bus service; kosmic-stated holds this bit for the applet.
    // Fire-and-forget: if the service is not running the applet reads unknown and disables its switch.
    DBusCall {
        id: stateCall
        service: "io.github.eduresser.kosmic"
        path: "/Tiling"
        dbusInterface: "io.github.eduresser.kosmic.Tiling"
        method: "SetTiling"
    }
    function publishTiling(on) {
        stateCall.arguments = [on === true];
        stateCall.call();
    }

    // cosmic-comp's swap grab takes bare arrows; a KWin script has no seat grab and only gets keys via registerShortcut,
    // so the arrows keep Meta and this OSD names the chord.
    property bool modeOsdEnabled: String(KWin.readConfig("ModeOsd", "true")).toLowerCase() === "true"
    function chordFor(handler) {
        for (var i = 0; i < Keymap.KEYS.length; i++) {
            if (Keymap.KEYS[i][4] === handler) return Keymap.KEYS[i][2];
        }
        return "";
    }
    function modeOsd(mode) {
        if (!root.modeOsdEnabled) return;
        var arrows = root.chordFor("focus-left").replace("Left", "\u2190\u2191\u2193\u2192");
        var text;
        if (mode === "swap") {
            text = "Swap: " + arrows + " to choose, " + root.chordFor("swap-window") + " to trade";
        } else if (mode === "resize") {
            text = "Resize: " + arrows + " to grow and shrink";
        } else {
            return;
        }
        osdCall.arguments = ["preferences-system-windows-effect-presentwindows", String(text)];
        osdCall.call();
    }

    // Plasma hides its OSD after 1800ms (OsdItem.qml:19) with no way to extend it, and modes here are toggles that can last
    // minutes, so the text is re-shown. Cost: it overwrites other OSDs (e.g. volume) while a mode is on.
    Timer {
        interval: 1200          // inside the 1800ms the OSD gives itself, with room for a slow call
        repeat: true
        running: root.activeMode !== "" && root.modeOsdEnabled
        onTriggered: root.modeOsd(root.activeMode)
    }

    function osd(text) {
        if (!root.osdEnabled) return;
        osdCall.arguments = ["preferences-system-windows-effect-presentwindows", String(text)];
        osdCall.call();
    }

    // The pointer must stay in one drop zone this long before the layout commits, so crossing a boundary in passing rearranges nothing.
    property alias dragTimer: dragTimerObj
    Timer {
        id: dragTimerObj
        interval: 150
        repeat: false
        onTriggered: { try { Kosmic.dragCommit(); } catch (e) { root.dbg("drag commit error: " + e); } }
    }

    // Waits out the desktop-switch slide before collecting empty workspaces: removing one mid-slide collapses the grid the effect reads.
    // The slide length is user-set, so KWin is asked: activeEffects lists "slide" until done. `switches` discards stale replies.
    property int switches: 0
    property int switchesAsked: 0
    function sweepWhenIdle() {
        root.switches++;
        sweepPoll.restart();
    }
    Timer {
        id: sweepPoll
        interval: 100
        repeat: false
        onTriggered: { root.switchesAsked = root.switches; effectsCall.call(); }
    }
    DBusCall {
        id: effectsCall
        service: "org.kde.KWin"
        path: "/Effects"
        dbusInterface: "org.freedesktop.DBus.Properties"
        method: "Get"
        arguments: ["org.kde.kwin.Effects", "activeEffects"]
        onFinished: (returnValue) => {
            if (root.switchesAsked !== root.switches) return;
            if (String(returnValue[0]).split(",").indexOf("slide") >= 0) { sweepPoll.restart(); return; }
            try { Kosmic.sweepWorkspaces(); } catch (e) { root.dbg("sweep error: " + e); }
        }
        onFailed: { try { Kosmic.sweepWorkspaces(); } catch (e) { root.dbg("sweep error: " + e); } }
    }

    property alias enforceTimer: enforceTimerObj
    Timer {
        id: enforceTimerObj
        interval: 120
        repeat: false
        onTriggered: { try { Kosmic.reconcile(); } catch (e) { root.dbg("enforce error: " + e); } }
    }

    Timer {
        interval: 1500
        running: true
        repeat: true
        onTriggered: { try { Kosmic.reconcile(); } catch (e) { root.dbg("reconcile error: " + e); } }
    }

    Component.onCompleted: {
        try {
            Kosmic.main({ "workspace": Workspace, "kwin": KWin, "options": Options }, { "root": root, "dbg": root.dbg });
        } catch (e) { root.dbg("main error: " + e + " @ " + e.stack); }
    }
}
