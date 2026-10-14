// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

import QtQuick
import QtQml.Models
import org.kde.kwin

import "../code/kosmic-tiling.mjs" as Kosmic
import "../code/keymap.mjs" as Keymap

Item {
    id: root
    // The mode the keyboard is in, or "" for none. A modal shortcut binds only while its own
    // mode is active, which is how the resize mode shares Meta+Left with focus. Generated from
    // keybindings.json; see modes.resize there for why those keys exist at all.
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

    // With the chordhold plugin on, the chord belongs to it: the plugin has to see Meta+X and
    // Meta+R itself, and it sits after InputFilterOrder::GlobalShortcut, so a shortcut registered
    // on the same chord matches first and fires the toggle alongside the gesture. The toggles are
    // therefore registered with an unpressable placeholder instead, which keeps the name alive for
    // the plugin to invoke without it holding a key.
    //
    // Done here rather than by writing kglobalshortcutsrc, because a session that installed the
    // script without a configuration manager has nobody to write that file. Where an entry does
    // exist it still wins -- a QML sequence is only the default used when the file has none.
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

    // Errors reach the journal (journalctl --user -b | grep kosmic-tiling). Only error paths and explicit
    // log() calls come through here, so this is quiet; a script that fails silently costs far more.
    function dbg(msg) { console.log("kosmic-tiling: " + msg); }

    // One tab bar per stack, created on demand and moved over the top of the slot by kosmic-tiling.mjs.
    // PlasmaCore.Dialog is the only way a KWin script reaches the screen; Krohnkite's layout popup uses
    // the same one. Created imperatively rather than through a Repeater so that a bar keeps its identity
    // (and stops flickering) while the layout moves it around.
    // The drop zone square, created once and moved for the rest of the drag.
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

    // Where the selection is, said twice, to two readers that cannot be told the same way.
    //
    // The outline plugin is C++ and takes a D-Bus call. The focusdim effect is a scripted effect
    // and cannot: the scripting API has `callDBus`, which only goes out, and registers no service
    // to be called on. Its only channel is a window it can see, which is what the marker below is.
    //
    // The marker used to be the only channel and the plugin read it too. It stopped being that
    // because of what a window a script opens *is* to the compositor: `InternalWindow::windowType`
    // returns Normal unconditionally (internalwindow.cpp:154), the Overview drops only Dock,
    // Desktop and the notification types, and no flag or property reaches that filter -- so an
    // invisible window kept mapped over the selection appeared in Meta+W, captioned
    // "kosmic-selection", with no way to take it off the list. The window had to stop existing,
    // and now it only exists where focusdim needs it to.
    DBusCall {
        id: selectionCall
        service: "org.kde.KWin"
        // The plugin's object, registered on the connection KWin already holds that name on, so
        // this reaches a plugin inside the same process. outline.cpp has the same two strings.
        path: "/kosmic/Selection"
        dbusInterface: "io.github.eduresser.kosmic.Selection"
        method: "SetSelection"
    }
    // One string rather than four numbers, and the reason is marshalling: DBusCall sends whatever
    // QVariant types QML's numbers happen to carry, an integral JS number is an int or a double
    // depending on how the engine is holding it, and a signature that does not match is a call
    // that fails silently. outline.h says the same thing from the other end.
    function publishSelection(rect) {
        selectionCall.arguments = [rect];
        selectionCall.call();
    }

    // Built only where focusdim is enabled, because it is the only reader left that needs it and a
    // window nothing reads is a window in the Overview for nothing. SelectionMarker in
    // [Script-kosmic-tiling], which install.sh writes alongside the effect it tracks.
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
    // hide(), not visible = false: the marker is parked rather than unmapped, because the effect
    // reads it by geometry and a window that comes and goes is a channel that comes and goes. See
    // Selection.qml. The plugin is told the other way, with the empty string it reads as "nothing".
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

    // Fallback indication for when the bar is turned off: Plasma's OSD names the member in front.
    property bool osdEnabled: String(KWin.readConfig("StackOsd", "false")).toLowerCase() === "true"
    DBusCall {
        id: osdCall
        service: "org.kde.plasmashell"
        path: "/org/kde/osdService"
        dbusInterface: "org.kde.osdService"
        method: "showText"
    }
    // The one value this script lets anything outside read, pushed because it cannot be asked for:
    // a KWin script registers no D-Bus service, has no writeConfig, and callDBus only goes out.
    // kosmic-stated is on the other end -- a session service that holds this single bit so the
    // panel applet's "Tile current workspace" can be a switch rather than a button. The call is
    // asynchronous and fire-and-forget, which is what makes it safe on the workspace-change path;
    // kosmic-tiling.mjs gates it on the value so an unchanged workspace costs nothing at all.
    //
    // Nothing checks whether it arrived. If the service is not running the value is simply not
    // published, and the applet reads "unknown" and disables its switch -- which is the correct
    // outcome and needs no error path here.
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

    // A mode has to say which keys it took, because here it cannot take the ones upstream takes.
    // cosmic-comp's SwapWindowGrab holds the seat's keyboard and matches a Focus binding on its
    // *key alone*, modifiers discarded (tiling/grabs/swap.rs :59), so a bare arrow moves the
    // selection and the application under it receives nothing. A KWin script has no seat grab and
    // no way to earn one: a window of its own reaches full QML focus -- active=true, the handler
    // item holding activeFocus -- and still gets no key, because KWin routes the keyboard to the
    // active client; and the scripted effects API has no keyboard call at all. registerShortcut,
    // which needs a chord, is the whole of it. So the arrows keep their Meta here, and this names
    // it -- upstream draws a SwapIndicator for the same reason, that a mode which says nothing is
    // a mode that silently changes what the next key does.
    property bool modeOsdEnabled: String(KWin.readConfig("ModeOsd", "true")).toLowerCase() === "true"
    // The chords are read back out of the generated keymap rather than written again here, so
    // rebinding a key in keybindings.json cannot leave the OSD naming the old one.
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
            // One chord, so there is no second one to name. What has to be said instead is that
            // the four arrows are two pairs rather than four directions to grow in.
            text = "Resize: " + arrows + " to grow and shrink";
        } else {
            return;
        }
        osdCall.arguments = ["preferences-system-windows-effect-presentwindows", String(text)];
        osdCall.call();
    }

    // Plasma hides its OSD after 1800ms (OsdItem.qml :19) and offers no way to ask for longer --
    // the D-Bus interface is showText and nothing else. Upstream can afford that, because a COSMIC
    // mode lasts exactly as long as the keys are held: SwapWindowGrab ends the moment the modifier
    // or the key is released, and the trade happens on that same release (input/mod.rs :2407). Here
    // the mode is a toggle, because KWin delivers an activation and never a release, so it can be
    // on for minutes -- and a message that leaves while the mode stays is the thing the OSD exists
    // to prevent, now with the extra cruelty of having said it once.
    //
    // A repeat rather than an overlay of our own, and that is a measurement rather than laziness:
    // Osd::showOsd only animates when the root object carries an `animateOpacity` property
    // (osd.cpp :303), and Plasma Osd.qml declares no such property, so the branch taken is a bare
    // `visible = true`. Re-showing the same text while it is up restarts the timer and changes
    // nothing on the screen. What it does cost: while a mode is on, this overwrites anybody else's
    // OSD within the interval -- change the volume during a swap and the volume reading is replaced
    // by this one. A mode is seconds long in practice and that is the cheaper of the two prices.
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

    // The pointer has to stay in one drop zone this long before the layout commits to it, so crossing a
    // boundary on the way somewhere else does not rearrange anything. The interval is set from the
    // script: cosmic-comp waits longer the first time a window leaves its own slot.
    property alias dragTimer: dragTimerObj
    Timer {
        id: dragTimerObj
        interval: 150
        repeat: false
        onTriggered: { try { Kosmic.dragCommit(); } catch (e) { root.dbg("drag commit error: " + e); } }
    }

    property alias sweepTimer: sweepTimerObj
    Timer {
        id: sweepTimerObj
        interval: 900
        repeat: false
        onTriggered: { try { Kosmic.sweepWorkspaces(); } catch (e) { root.dbg("sweep error: " + e); } }
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
