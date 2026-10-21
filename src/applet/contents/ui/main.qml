// Controls live here because a KWin::Plugin has no config dialog and a kcfg key is not read by a running script until relogin.
// Everything reaches KWin through busctl via the executable data engine: QML has no D-Bus binding and busctl ships with systemd.
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.plasma.plasmoid
import org.kde.plasma.components as PlasmaComponents
import org.kde.plasma.extras as PlasmaExtras
import org.kde.plasma.plasma5support as Plasma5Support
import org.kde.kirigami as Kirigami
// KDE's own segmented and colour buttons, copied in rather than imported: a QML module absent from a distro's plasmashell
// leaves the popup not opening (see vendor/README).
import "vendor" as Vendor

PlasmoidItem {
    id: root

    // The registered name is KosmicTiling, not the ToggleTiling action in keybindings.json; the wrong one succeeds and does nothing.
    readonly property string toggleShortcut: "KosmicTiling"

    readonly property string scriptGroup: "Script-kosmic-tiling"

    // A plugin is not a KPackage, so it has no kcfg dialog; it reads this group with a fresh KConfig on construction,
    // so unload plus load applies a change without a logout.
    readonly property string outlineGroup: "Plugin-kosmic-outline"

    // A script reads its kcfg only on load and `reconfigure` does not reach it, so the tiler is asked through this shortcut.
    readonly property string reloadShortcut: "KosmicReloadSettings"

    // Line = compiled plugin (a script window cannot stack below a menu); dimming = effect. One control drives both.
    readonly property var hintPieces: [
        { id: "kosmic-focusdim", object: "/Effects", iface: "org.kde.kwin.Effects", property: "loadedEffects", load: "loadEffect", unload: "unloadEffect" },
        { id: "kosmic-outline",  object: "/Plugins", iface: "org.kde.KWin.Plugins", property: "LoadedPlugins", load: "LoadPlugin", unload: "UnloadPlugin" }
    ]

    readonly property string stateService: "io.github.eduresser.kosmic"
    readonly property string statePath: "/Tiling"
    readonly property string stateIface: "io.github.eduresser.kosmic.Tiling"
    readonly property string publishShortcut: "KosmicPublishState"

    // Three states: "nobody answered" (tiler not loaded, or not yet registered at login) must differ from "off".
    property bool tilingOn: false
    property bool tilingKnown: false

    property bool hintOn: false
    // Apart from hintOn: only this says whether the plugin is up; reloading one that was off would switch it on.
    property bool outlineOn: false
    // settings.json: kosmic-outline.Thickness; tools/parity.mjs keeps it equal.
    property int hintThickness: 3
    // settings.json: kosmic-outline.FallbackRadius, for windows that draw their own frame.
    property int hintRadius: 8
    // "" means the scheme's accent (cosmic-comp: theme.accent_color(), src/theme.rs:15); the plugin watches kdeglobals.
    property string hintColor: ""
    property int gapInner: 8
    property int gapOuter: 0
    property bool newWorkspaceTiled: true
    property string focusChord: ""
    property string moveChord: ""
    property string floatChord: ""

    // True once the state has been read at all; before the first answer there is no state to show.
    property bool tilingEverKnown: false

    // Follows the last known state, not the current reading: kosmic-stated expires its value, which would blank the bar icon.
    // Icon names, not paths: only a name goes through KIconLoader and takes the colour scheme's text colour.
    Plasmoid.icon: !root.tilingEverKnown ? "kosmic-tiling-symbolic"
                                         : (root.tilingOn ? "kosmic-tiling-on-symbolic"
                                                          : "kosmic-tiling-off-symbolic")
    toolTipMainText: i18n("KOSMIC Tiling")
    toolTipSubText: i18n("Tiling controls for the current workspace")

    // Read only while the popup is open, so nothing is polled for an unseen panel.
    onExpandedChanged: if (expanded) refresh()

    Component.onCompleted: {
        refresh()
        // Not in refresh(): this arms a wait that outlives the popup and must not be armed twice.
        watchTiling()
    }

    function refresh() {
        readTiling()
        readHint()
        readOutline()
        readGaps()
        readNewWorkspace()
        readChords()
    }


    Plasma5Support.DataSource {
        id: exec
        engine: "executable"
        connectedSources: []

        // A Map, not an object literal: a computed key stored in a `property var` object crashed plasmashell
        // (QV4::Object::insertMember, Qt 6.11.1).
        property var pending: new Map()

        // One command per string: the engine keys sources by command, so a second connect would collapse and lose its callback.
        function run(cmd, callback) {
            if (pending.has(cmd)) return
            pending.set(cmd, callback || null)
            connectSource(cmd)
        }

        onNewData: function (source, data) {
            disconnectSource(source)
            const cb = pending.get(source)
            pending.delete(source)
            if (cb) cb(data["exit code"] === 0, String(data.stdout || "").trim())
        }
    }

    // busctl --json=short: for a property `data` is the value, for a call it is the list of return values ([false] for a `b`).
    function dbusProperty(object, iface, property, callback) {
        exec.run("busctl --user --json=short get-property org.kde.KWin " + object + " " + iface + " " + property,
                 function (ok, out) {
                     if (!ok) return callback(null)
                     try { callback(JSON.parse(out).data) } catch (e) { callback(null) }
                 })
    }

    function dbusCall(object, iface, method, arg) {
        exec.run("busctl --user --json=short call org.kde.KWin " + object + " " + iface + " " + method + " s " + arg)
    }


    readonly property string invoke: "busctl --user call org.kde.kglobalaccel /component/kwin " +
                                     "org.kde.kglobalaccel.Component invokeShortcut s "

    // Ask then read in one shell command: separate exec.run calls run concurrently and the read would race the request.
    // The sequence is also the liveness check, since kosmic-stated expires stale values.
    function readTiling() {
        exec.run(root.invoke + root.publishShortcut + " >/dev/null 2>&1; " +
                 "busctl --user --json=short get-property " + root.stateService + " " +
                 root.statePath + " " + root.stateIface + " State",
                 function (ok, out) {
                     let v = null
                     if (ok) { try { v = JSON.parse(out).data } catch (e) { v = null } }
                     root.takeTiling(v)
                 })
    }

    // tilingOn is never written from an expiry, so the bar icon keeps the last state while tilingKnown greys out the switch.
    function takeTiling(value) {
        root.tilingKnown = (value === "on" || value === "off")
        if (!root.tilingKnown) return
        root.tilingOn = (value === "on")
        root.tilingEverKnown = true
    }

    // Long poll: kosmic-stated holds the call until the state changes. `busctl monitor | grep -m1` was tried and returns late (5.9s, src/state/tiling.h).
    // --timeout must exceed kosmic-stated's ten-minute window, or busctl's 25s default turns this back into a poll.
    readonly property string watchCommand:
        "busctl --user --timeout=660 --json=short call " + stateService + " " + statePath + " " +
        stateIface + " WaitForChange"

    function watchTiling() {
        exec.run(root.watchCommand, function (ok, out) {
            if (!ok) {
                // Nobody answering: re-arming at once would spin as fast as a process can start.
                watchRetry.restart()
                return
            }
            let v = null
            try { v = JSON.parse(out).data[0] } catch (e) { v = null }
            root.takeTiling(v)
            // Qt.callLater: exec.run drops its pending guard before the callback, so a synchronous answer would nest a frame per cycle
            // ("Maximum call stack size exceeded").
            Qt.callLater(root.watchTiling)
        })
    }

    Timer {
        id: watchRetry
        interval: 5000
        onTriggered: root.watchTiling()
    }

    function toggleTiling() {
        // kglobalaccel, not KWin: the tiler owns the behaviour, so this cannot disagree with Meta+Y. It acts on the focused space,
        // which may not be the screen this panel is on.
        exec.run(root.invoke + root.toggleShortcut, function () { root.readTiling() })
    }

    // While the popup is open: the long poll keeps the state current, this forces a publish to refresh kosmic-stated's expiry,
    // so the interval must stay well inside it.
    Timer {
        id: tilingPoll
        interval: 2000
        repeat: true
        running: root.expanded
        onTriggered: root.readTiling()
    }


    function readNewWorkspace() {
        exec.run("kreadconfig6 --file kwinrc --group " + root.scriptGroup + " --key NewWorkspaceTiled",
                 function (ok, out) { root.newWorkspaceTiled = !ok || out !== "false" })
    }

    function setNewWorkspace(tiled) {
        // Written then announced by shortcut: a running script does not see `reconfigure` (measured: the next workspace still came up tiled).
        // Same path chordhold/ uses for KosmicSwapArm.
        exec.run("kwriteconfig6 --file kwinrc --group " + root.scriptGroup +
                 " --key NewWorkspaceTiled " + (tiled ? "true" : "false") + " && " + root.invoke +
                 (tiled ? "KosmicNewWorkspaceTiled" : "KosmicNewWorkspaceFloating"),
                 // The tiler republishes: this default answers for every empty workspace, often this one.
                 function () { root.readNewWorkspace(); root.readTiling() })
    }


    function readHint() {
        let seen = 0
        let any = false
        for (const piece of hintPieces) {
            const p = piece
            dbusProperty(p.object, p.iface, p.property, function (list) {
                const on = Array.isArray(list) && list.indexOf(p.id) >= 0
                if (on) any = true
                if (p.id === "kosmic-outline") root.outlineOn = on
                if (++seen === hintPieces.length) root.hintOn = any
            })
        }
    }

    function setHint(on) {
        for (const piece of hintPieces) {
            const p = piece
            if (!on) {
                dbusCall(p.object, p.iface, p.unload, p.id)
                continue
            }
            // Restore what was configured, not what is installed: the package ships both halves regardless of the enable options;
            // kreadconfig6 reads the same /etc/xdg + ~/.config merge KWin does.
            exec.run("kreadconfig6 --file kwinrc --group Plugins --key " + p.id + "Enabled",
                     function (ok, out) {
                         if (!ok || out !== "true") return
                         if (p.id !== "kosmic-outline") {
                             dbusCall(p.object, p.iface, p.load, p.id)
                             return
                         }
                         // Load then nudge in one command (as in setOutline): a fresh plugin knows no selection, and separate exec.run calls run
                         // concurrently. The effect needs no nudge.
                         exec.run("busctl --user call org.kde.KWin " + p.object + " " + p.iface +
                                  " " + p.load + " s " + p.id + " >/dev/null; " +
                                  root.invoke + root.reloadShortcut)
                     })
        }
        // Asynchronous writes; the switch follows the read-back, so nothing here assigns `checked`.
        hintRecheck.restart()
    }

    Timer {
        id: hintRecheck
        interval: 400
        onTriggered: root.readHint()
    }


    function readOutline() {
        exec.run("for k in Thickness FallbackRadius Color; do echo \"$k=$(kreadconfig6 --file kwinrc --group " +
                 root.outlineGroup + " --key $k)\"; done",
                 function (ok, out) {
                     if (!ok) return
                     for (const line of out.split("\n")) {
                         const at = line.indexOf("=")
                         if (at < 0) continue
                         const k = line.slice(0, at), v = line.slice(at + 1).trim()
                         if (k === "Thickness") {
                             const n = parseInt(v, 10)
                             // The plugin's default, not 0: an unset key reads empty and a 0px line looks like the hint being off.
                             root.hintThickness = isNaN(n) || n < 1 ? 3 : n
                         } else if (k === "FallbackRadius") {
                             const r = parseInt(v, 10)
                             // 0 is a real answer (a square line); only a non-number falls back.
                             root.hintRadius = isNaN(r) || r < 0 ? 8 : r
                         } else if (k === "Color") {
                             root.hintColor = v
                         }
                     }
                 })
    }

    // Six digits: String(colour) gives #aarrggbb for a translucent colour, but this key is written #rrggbb everywhere else.
    function hexOf(c) {
        function two(v) { return ("0" + Math.round(v * 255).toString(16)).slice(-2) }
        return "#" + two(c.r) + two(c.g) + two(c.b)
    }

    // Written, then the plugin re-reads it in its constructor (fresh KConfig), so unload plus load reloads it; only when it is up,
    // else the hint would turn on. KosmicReloadSettings re-pushes the selection, which a new plugin instance lacks.
    function setOutline(key, value) {
        const quoted = "'" + String(value).replace(/'/g, "") + "'"
        let cmd = "kwriteconfig6 --file kwinrc --group " + root.outlineGroup +
                  " --key " + key + " " + quoted
        if (root.outlineOn) {
            cmd += "; busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins " +
                   "UnloadPlugin s kosmic-outline" +
                   "; busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins " +
                   "LoadPlugin s kosmic-outline" +
                   "; " + root.invoke + root.reloadShortcut
        }
        exec.run(cmd, function () { root.readOutline(); root.readHint() })
    }


    function readGaps() {
        exec.run("for k in GapInner GapOuter; do echo \"$k=$(kreadconfig6 --file kwinrc --group " +
                 root.scriptGroup + " --key $k)\"; done",
                 function (ok, out) {
                     if (!ok) return
                     for (const line of out.split("\n")) {
                         const at = line.indexOf("=")
                         if (at < 0) continue
                         const n = parseInt(line.slice(at + 1).trim(), 10)
                         if (isNaN(n)) continue
                         if (line.slice(0, at) === "GapInner") root.gapInner = n
                         else root.gapOuter = n
                     }
                 })
    }

    // Order matters: reconfigure makes KWin drop its cached config (measured: without it the tiler re-reads the old numbers),
    // then the shortcut tells the tiler to read; reconfigure alone reaches no script.
    function setGaps(inner, outer) {
        exec.run("kwriteconfig6 --file kwinrc --group " + root.scriptGroup + " --key GapInner " + inner +
                 " && kwriteconfig6 --file kwinrc --group " + root.scriptGroup + " --key GapOuter " + outer +
                 " && busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure >/dev/null" +
                 " && " + root.invoke + root.reloadShortcut,
                 function () { root.readGaps() })
    }

    // A spin box fires on every arrow click and each write is three processes plus a relayout, so wait for the clicking to stop.
    // These spins show the clicked value, not the read-back, or they would snap back on every click.
    Timer {
        id: gapWrite
        interval: 400
        onTriggered: root.setGaps(root.gapInner, root.gapOuter)
    }
    Timer {
        id: outlineWrite
        interval: 400
        onTriggered: root.setOutline("Thickness", root.hintThickness)
    }
    Timer {
        id: radiusWrite
        interval: 400
        onTriggered: root.setOutline("FallbackRadius", root.hintRadius)
    }


    // A dialog takes focus and closes the popup, so the popup is pinned while it is up. It is released when the popup window goes
    // active again: Vendor.ColorButton exposes no rejected signal, and a cancelled dialog would leave it pinned.
    function pinPopup() {
        Plasmoid.hideOnWindowDeactivate = false
    }
    function releasePopup() {
        Plasmoid.hideOnWindowDeactivate = true
    }


    // Read from kglobalaccel's store, not hardcoded: the chords come from keybindings.json and chordHold moves one.
    function readChords() {
        const names = ["KosmicFocusLeft", "KosmicFocusRight", "KosmicFocusUp", "KosmicFocusDown",
                       "KosmicMoveWindowLeft", "KosmicMoveWindowRight", "KosmicMoveWindowUp",
                       "KosmicMoveWindowDown", "KosmicFloating"]
        // One shell round trip for all nine; kreadconfig6 because only it applies the XDG merge.
        exec.run("for k in " + names.join(" ") + "; do echo \"$k=$(kreadconfig6 --file " +
                 "kglobalshortcutsrc --group kwin --key $k)\"; done",
                 function (ok, out) {
                     if (!ok) return
                     const got = {}
                     for (const line of out.split("\n")) {
                         const at = line.indexOf("=")
                         if (at < 0) continue
                         // Stored as "active,default,friendly name"; the first field is what the user presses.
                         got[line.slice(0, at)] = line.slice(at + 1).split(",")[0].trim()
                     }
                     root.focusChord = family([got.KosmicFocusLeft, got.KosmicFocusRight,
                                               got.KosmicFocusUp, got.KosmicFocusDown])
                     root.moveChord = family([got.KosmicMoveWindowLeft, got.KosmicMoveWindowRight,
                                              got.KosmicMoveWindowUp, got.KosmicMoveWindowDown])
                     root.floatChord = got.KosmicFloating || ""
                 })
    }

    // A shared modifier reads as one line ("Super + arrows"); if a chord was rebound out of the family, show only the first.
    function family(chords) {
        const valid = chords.filter(function (c) { return c && c.length })
        if (!valid.length) return ""
        const prefixOf = function (c) { const p = c.split("+"); p.pop(); return p.join("+") }
        const first = prefixOf(valid[0])
        if (!first.length) return valid[0]
        for (const c of valid) if (prefixOf(c) !== first) return valid[0]
        return first + "+" + i18n("arrows")
    }



    // No header or footer band, as in upstream: a PlasmoidHeading with anchored content reports no implicit height,
    // so the popup would come out one row short.
    fullRepresentation: PlasmaExtras.Representation {
        id: popup

        Layout.minimumWidth: Kirigami.Units.gridUnit * 20
        Layout.maximumWidth: Kirigami.Units.gridUnit * 26
        // Measured from the Page, which reports a content height only when the column is its contentItem; as a loose child it answered 16 and clipped two rows.
        Layout.minimumHeight: implicitHeight
        Layout.preferredHeight: implicitHeight


        // Upstream pads rows by space_m and dividers by space_s (src/applet/mod.rs:614-626); largeSpacing reproduces the 1:2:3 ratio.
        // Dividers overshoot rows by 8 per side: the popup pads to the divider's inset and rows take the other 8, no negative margins.
        readonly property int rowInset: Kirigami.Units.largeSpacing

        leftPadding: Kirigami.Units.largeSpacing * 2
        rightPadding: Kirigami.Units.largeSpacing * 2
        topPadding: Kirigami.Units.largeSpacing * 2
        bottomPadding: Kirigami.Units.largeSpacing * 2

        collapseMarginsHint: true

        contentItem: ColumnLayout {
            id: contents
            spacing: Kirigami.Units.largeSpacing * 2

            // Reads the workspace the keyboard is on, which with two monitors may differ from this panel's; the tiler decides.
            RowLayout {
                Layout.fillWidth: true
                Layout.leftMargin: popup.rowInset
                Layout.rightMargin: popup.rowInset
                spacing: Kirigami.Units.largeSpacing

                PlasmaComponents.Label {
                    text: i18n("Tile current workspace")
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                    enabled: root.tilingKnown
                }
                PlasmaComponents.Switch {
                    checked: root.tilingOn
                    enabled: root.tilingKnown
                    // Restoring the binding keeps the switch following the tiler: a Switch writes its own `checked` on click, replacing it.
                    onClicked: {
                        checked = Qt.binding(function () { return root.tilingOn })
                        root.toggleTiling()
                    }
                }
            }

            Kirigami.Separator {
                Layout.fillWidth: true
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.leftMargin: popup.rowInset
                Layout.rightMargin: popup.rowInset
                spacing: Kirigami.Units.largeSpacing

                PlasmaComponents.Label {
                    text: i18n("New workspace behavior")
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                }

                Vendor.SegmentedButton {
                    actions: [newWorkspaceTiledAction, newWorkspaceFloatingAction]
                }
            }

            // `checked` goes through a Binding: a checkable Action toggles its own `checked`, which would replace a plain binding for good
            // and let the strip drift from what the key says.
            Kirigami.Action {
                id: newWorkspaceTiledAction
                text: i18n("Tiled")
                checkable: true
                // An Action fires on every click, selected or not; clicking the current half must not rewrite.
                onTriggered: { if (!root.newWorkspaceTiled) root.setNewWorkspace(true) }
            }
            Kirigami.Action {
                id: newWorkspaceFloatingAction
                text: i18n("Floating")
                checkable: true
                onTriggered: { if (root.newWorkspaceTiled) root.setNewWorkspace(false) }
            }
            Binding {
                target: newWorkspaceTiledAction
                property: "checked"
                value: root.newWorkspaceTiled
            }
            Binding {
                target: newWorkspaceFloatingAction
                property: "checked"
                value: !root.newWorkspaceTiled
            }

            Kirigami.Separator {
                Layout.fillWidth: true
            }

            Repeater {
                model: [
                    { label: i18n("Navigate windows"), chord: root.focusChord },
                    { label: i18n("Move window"), chord: root.moveChord },
                    { label: i18n("Toggle floating window"), chord: root.floatChord }
                ]
                delegate: RowLayout {
                    required property var modelData
                    Layout.fillWidth: true
                    Layout.leftMargin: popup.rowInset
                    Layout.rightMargin: popup.rowInset
                    spacing: Kirigami.Units.largeSpacing
                    // Never hidden on an empty chord: chords arrive from a subprocess, and rows appearing late grow the popup after it was sized.

                    PlasmaComponents.Label {
                        text: modelData.label
                        Layout.fillWidth: true
                        elide: Text.ElideRight
                    }
                    PlasmaComponents.Label {
                        text: modelData.chord
                        font: Kirigami.Theme.smallFont
                        opacity: 0.7
                    }
                }
            }

            Kirigami.Separator {
                Layout.fillWidth: true
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.leftMargin: popup.rowInset
                Layout.rightMargin: popup.rowInset
                spacing: Kirigami.Units.largeSpacing

                PlasmaComponents.Label {
                    text: i18n("Active hint")
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                }
                PlasmaComponents.Switch {
                    checked: root.hintOn
                    onClicked: {
                        const want = checked
                        checked = Qt.binding(function () { return root.hintOn })
                        root.setHint(want)
                    }
                }
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.leftMargin: popup.rowInset
                Layout.rightMargin: popup.rowInset
                spacing: Kirigami.Units.largeSpacing
                enabled: root.hintOn

                PlasmaComponents.Label {
                    text: i18n("Thickness")
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                }
                PlasmaComponents.SpinBox {
                    // Starts at 1: upstream's 0 is a second way of saying off, which the switch above already says.
                    from: 1
                    to: 64
                    value: root.hintThickness
                    onValueModified: {
                        root.hintThickness = value
                        // The gap rises with the line (cosmic-settings theme_manager.rs:696): the line is drawn in the gap.
                        if (root.gapInner < value) {
                            root.gapInner = value
                            gapWrite.restart()
                        }
                        outlineWrite.restart()
                    }
                }
            }

            // Corner for windows that draw their own frame (Chromium, GTK, Electron) and so report none to KWin.
            RowLayout {
                Layout.fillWidth: true
                Layout.leftMargin: popup.rowInset
                Layout.rightMargin: popup.rowInset
                spacing: Kirigami.Units.largeSpacing
                enabled: root.hintOn

                PlasmaComponents.Label {
                    text: i18n("Active border radius")
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                }
                PlasmaComponents.SpinBox {
                    from: 0
                    to: 32
                    value: root.hintRadius
                    QQC2.ToolTip.text: i18n("Corner of the line around windows that draw their own frame")
                    QQC2.ToolTip.visible: hovered
                    QQC2.ToolTip.delay: Kirigami.Units.toolTipDelay
                    onValueModified: {
                        root.hintRadius = value
                        radiusWrite.restart()
                    }
                }
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.leftMargin: popup.rowInset
                Layout.rightMargin: popup.rowInset
                spacing: Kirigami.Units.largeSpacing
                enabled: root.hintOn

                PlasmaComponents.Label {
                    text: i18n("Active hint colour")
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                }

                PlasmaComponents.ToolButton {
                    visible: root.hintColor.length > 0
                    icon.name: "edit-undo"
                    flat: true
                    display: QQC2.AbstractButton.IconOnly
                    implicitWidth: Kirigami.Units.gridUnit * 1.5
                    implicitHeight: Kirigami.Units.gridUnit * 1.5
                    QQC2.ToolTip.text: i18n("Follow the colour scheme")
                    QQC2.ToolTip.visible: hovered
                    QQC2.ToolTip.delay: Kirigami.Units.toolTipDelay
                    onClicked: {
                        root.hintColor = ""
                        root.setOutline("Color", "")
                    }
                }

                // Shows what is drawn, not what is written: an empty key means the scheme's accent, which the plugin resolves to
                // (Kirigami.Theme.highlightColor).
                Vendor.ColorButton {
                    id: hintColorButton
                    // Six hex digits is what the key holds everywhere; an alpha channel could not be written or read back.
                    showAlphaChannel: false
                    dialogTitle: i18n("Active window hint colour")
                    implicitHeight: Kirigami.Units.gridUnit * 1.5
                    onPressed: root.pinPopup()
                    onAccepted: function (picked) {
                        const want = root.hexOf(picked)
                        if (want === root.hintColor) return
                        root.hintColor = want
                        root.setOutline("Color", want)
                    }
                    // `color` aliases the dialog's selectedColor, so a pick replaces a plain binding; Binding re-asserts it.
                    Binding {
                        target: hintColorButton
                        property: "color"
                        value: root.hintColor.length > 0 ? root.hintColor
                                                         : Kirigami.Theme.highlightColor
                    }
                    // Releases the pin (see pinPopup): the window goes inactive when the dialog takes focus and active again on either exit.
                    Connections {
                        target: hintColorButton.Window.window
                        function onActiveChanged() {
                            const w = hintColorButton.Window.window
                            if (w && w.active) root.releasePopup()
                        }
                    }
                    QQC2.ToolTip.text: root.hintColor.length > 0 ? root.hintColor
                                                                 : i18n("The colour scheme's accent")
                    QQC2.ToolTip.visible: hovered
                    QQC2.ToolTip.delay: Kirigami.Units.toolTipDelay
                }
            }

            Kirigami.Separator {
                Layout.fillWidth: true
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.leftMargin: popup.rowInset
                Layout.rightMargin: popup.rowInset
                spacing: Kirigami.Units.largeSpacing

                PlasmaComponents.Label {
                    text: i18n("Gap between windows")
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                }
                PlasmaComponents.SpinBox {
                    // The hint's thickness is the floor (cosmic-settings appearance/mod.rs:837) because the line is drawn in this gap; only while the hint is on.
                    from: root.hintOn ? root.hintThickness : 0
                    to: 500
                    value: root.gapInner
                    onValueModified: {
                        root.gapInner = value
                        gapWrite.restart()
                    }
                }
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.leftMargin: popup.rowInset
                Layout.rightMargin: popup.rowInset
                spacing: Kirigami.Units.largeSpacing

                PlasmaComponents.Label {
                    // Outer is an extra edge gap on top of the inner one, default 0, so edges and seams match.
                    text: i18n("Extra gap at screen edges")
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                }
                PlasmaComponents.SpinBox {
                    // No floor: this gap is added to the other, which already makes room for the line; same ceiling so the sum stays readable.
                    from: 0
                    to: 500
                    value: root.gapOuter
                    onValueModified: {
                        root.gapOuter = value
                        gapWrite.restart()
                    }
                }
            }

            Kirigami.Separator {
                Layout.fillWidth: true
            }

            // No window-management KCM exists and the script's dialog has no deep link, so this opens the list holding it.
            PlasmaComponents.Button {
                id: settingsButton
                text: i18n("Window management settings…")
                flat: true
                Layout.fillWidth: true
                leftPadding: popup.rowInset
                rightPadding: popup.rowInset
                contentItem: PlasmaComponents.Label {
                    text: settingsButton.text
                    horizontalAlignment: Text.AlignLeft
                    verticalAlignment: Text.AlignVCenter
                    elide: Text.ElideRight
                }
                onClicked: {
                    exec.run("kcmshell6 kcm_kwin_scripts")
                    root.expanded = false
                }
            }
        }
    }
}
