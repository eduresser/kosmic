// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// KOSMIC's panel applet, following cosmic-applets/cosmic-applet-tiling.
//
// The popup opens on upstream's list, in upstream's order and with upstream's wording: a control
// for tiling on the current workspace, the default for new workspaces, the three navigation
// chords, the active hint, and the way into the settings. Those are the nine `fl!` keys
// cosmic-applet-tiling's `view()` actually renders -- the .ftl beside it also carries `gaps`,
// `floating-window-exceptions`, `view-all-shortcuts`, `all-workspaces` and `per-workspace`, none
// of which that file uses.
//
// Then it carries four controls upstream's applet does not: the hint's thickness and colour, and
// the two gaps. COSMIC has all four -- they are in cosmic-settings, under Appearance rather than
// under Window management, as "Active window hint size" (a spin, 0 to 64), "Gaps around tiled
// windows" (a spin, the hint size to 500), "Use theme accent color as active window hint" (a
// toggle) and "Active window hint color" (a picker with hex and RGB fields, shown only when that
// toggle is off). What moves here is where they live, not whether they exist, and the reason is
// KWin's rather than a preference. In COSMIC the settings application writes the one config file
// the compositor is watching, so a value applies as it is moved. Here the equivalents are a
// `KWin::Plugin`, which can have no configuration dialog at all (`contents/config` is a KPackage
// thing and a plugin is not one), and a kcfg dialog that writes a key a running script will not
// read until the next login. This is the only surface in the module that can both write those
// kwinrc groups and tell the thing that owns them to look again -- so the controls that have to
// apply live are here.
//
// That is not a lonely position. `pop-os/shell` -- COSMIC tiling's predecessor, the same work on
// GNOME -- is in exactly this one: a shell with no page of its own in the settings application.
// It put the same controls in the panel menu, and that menu is what the second half of this popup
// follows: "Show Active Hint", a number entry, "Active Hint Color" as a label with one swatch
// that opens a picker, and "Gaps" (src/panel_settings.ts:80-99). So the shape is upstream's too,
// just the other upstream's -- COSMIC decides what the defaults are and what it all looks like,
// Pop Shell decides which controls a panel menu is allowed to hold.
//
// The one place both were read and only one followed is the colour's default. Pop Shell stores a
// literal and writes it over the stylesheet on every repaint (`border-color: ${color_value}` in
// src/window.ts:661), so its hint never follows a GNOME theme change -- dark.css and light.css
// carry two different oranges that the inline style makes dead letters. cosmic-comp resolves an
// unset hint to the theme's accent and watches the light config, the dark config and the mode. We
// follow COSMIC: nothing written means the colour scheme's accent, and the plugin watches
// kdeglobals so switching scheme moves the line.
//
// Upstream's ranges come with them, including the one that couples two of the controls: the gap
// between windows cannot go below the hint's thickness, and raising the thickness past the gap
// raises the gap with it. That is not tidiness. The line is drawn in the gap, which is what lets
// two neighbours' hints meet in the seam instead of overlapping, and a gap narrower than the line
// has nowhere to put it.
//
// Live, in both cases, by two different routes. The gaps: write, `org.kde.KWin.reconfigure` so
// KWin drops the configuration it is holding, then `KosmicReloadSettings` so the tiler reads it
// again and lays every space out. The line: write, then unload and load the plugin, which reads
// kwinrc with a fresh KConfig in its constructor exactly so that this works.
//
// Every control here shows state, which took a service to arrange. A KWin script publishes
// nothing -- callDBus only goes out, there is no writeConfig, and the scripting API registers no
// service -- so `tilingEnabled` in core.mjs used to be unreadable from here and `tile-current` was
// a button, a control that claims no state because it had none to claim. kosmic-stated now holds
// that one value: the tiler pushes it, this reads it, and the control is the toggler upstream has.
// See state/.
//
// The other two were readable already: the active hint is a KWin effect and a KWin plugin, both
// published as properties that emit their own change, and the new-workspace default is a kwinrc
// key this applet writes and reads back.
//
// Everything reaches KWin through `busctl`, run by Plasma's executable data engine. QML has no
// D-Bus binding, and busctl ships with systemd, so it is the one call that is always present.
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.plasma.plasmoid
import org.kde.plasma.components as PlasmaComponents
import org.kde.plasma.extras as PlasmaExtras
import org.kde.plasma.plasma5support as Plasma5Support
import org.kde.kirigami as Kirigami
// The two controls this popup needs that Plasma's own component set does not have: a segmented
// button and a colour button. Both were drawn by hand first and both looked like what they were,
// so these are KDE's own, copied in rather than imported -- plain QML, upstream's SPDX headers
// kept, one import rewired. vendor/README says why a copy and not an import: which QML modules a
// plasmashell carries is each distribution's decision, and a module that turns out to be absent
// does not degrade, it leaves the popup not opening with one line in the journal.
import "vendor" as Vendor

PlasmoidItem {
    id: root

    // The shortcut the tiler registers for its `tiling` handler. The name comes from
    // keybindings.json and not from a guess: the action there is ToggleTiling but the registered
    // name is KosmicTiling, and invoking the wrong one returns success and does nothing.
    readonly property string toggleShortcut: "KosmicTiling"

    // The group KWin gives the script's kcfg entries. What this control writes lands in
    // ~/.config/kwinrc, which KWin reads after any /etc/xdg copy a packager may have put there --
    // so a distribution default and this control are the same setting, with the session's answer
    // winning.
    readonly property string scriptGroup: "Script-kosmic-tiling"

    // The outline plugin's own kwinrc group. A plugin is not a KPackage, so it has no
    // `contents/config` and no dialog can be built for it -- which is why its two visible settings
    // are here. It reads this group with a fresh KConfig every time it is constructed, so
    // unloading and loading it is how a change applies without a logout.
    readonly property string outlineGroup: "Plugin-kosmic-outline"

    // Tells the running tiler to read its configuration again. Needed because a KWin script reads
    // its kcfg when it loads: `reconfigure` makes KWin drop what it is holding but reaches no
    // script, so something has to ask. Same mechanism as KosmicNewWorkspaceTiled.
    readonly property string reloadShortcut: "KosmicReloadSettings"

    // The two halves of COSMIC's active hint. The line is a compiled plugin because a script's
    // window cannot be stacked below a menu, and the dimming is
    // an effect because it has no stacking order to lose. One control drives both.
    readonly property var hintPieces: [
        { id: "kosmic-focusdim", object: "/Effects", iface: "org.kde.kwin.Effects", property: "loadedEffects", load: "loadEffect", unload: "unloadEffect" },
        { id: "kosmic-outline",  object: "/Plugins", iface: "org.kde.KWin.Plugins", property: "LoadedPlugins", load: "LoadPlugin", unload: "UnloadPlugin" }
    ]

    // kosmic-stated, the service that holds the tiler's answer. Addressed by constants rather than
    // discovered, because there is exactly one of it and a wrong name here fails the same way a
    // missing service does -- the switch greys out and says so.
    readonly property string stateService: "io.github.eduresser.kosmic"
    readonly property string statePath: "/Tiling"
    readonly property string stateIface: "io.github.eduresser.kosmic.Tiling"
    readonly property string publishShortcut: "KosmicPublishState"

    // Three states, not two. "Nobody answered" has to be distinguishable from "tiling is off":
    // the tiler may not be loaded, or may be within the few seconds it waits before registering
    // its shortcuts at login, and a switch resting at off would be a confident wrong reading of
    // either. tilingKnown is what is shown instead of that guess.
    property bool tilingOn: false
    property bool tilingKnown: false

    property bool hintOn: false
    // Tracked apart from hintOn, which is "either half is loaded". Only this one says whether the
    // plugin that draws the line is up, and therefore whether changing its thickness or colour
    // needs it reloaded -- unloading and loading a plugin that was off would switch it on.
    property bool outlineOn: false
    // settings.json: kosmic-outline.Thickness -- restated here because the slider has to open at
    // something before the first read lands. tools/parity.mjs keeps it equal to the declaration.
    property int hintThickness: 3
    // "" means the colour scheme's accent, which is what the plugin falls back to and what
    // Kirigami.Theme.highlightColor resolves to. It is a value and not an absence, and it is
    // upstream's: cosmic-comp resolves an unset hint to `theme.accent_color()` (src/theme.rs:15),
    // so following the scheme is the state this module ships in and a written colour is the
    // override. The plugin watches kdeglobals, so this one tracks a theme change on its own.
    property string hintColor: ""
    property int gapInner: 8
    property int gapOuter: 0
    property bool newWorkspaceTiled: true
    property string focusChord: ""
    property string moveChord: ""
    property string floatChord: ""

    // True once the state has been read at all. The pair below is the state's, and before the
    // first answer there is no state to show -- that is a third case upstream never has, because
    // cosmic-applet-tiling reads `autotiled` out of its own memory and is never in the dark.
    property bool tilingEverKnown: false

    // Upstream's pair, swapped on the state the way `icon_button(if self.autotiled { ON } else
    // { OFF })` swaps them (cosmic-applet-tiling/src/window.rs:246). The neutral third is this
    // module's and is only on screen until the first answer arrives, which is the one moment the
    // applet genuinely does not know.
    //
    // It follows the *last known* state and not the current reading. kosmic-stated expires what
    // it holds after a few seconds, deliberately, so that a reader can tell "off" from "nobody
    // answered" -- and a bar icon that honoured the expiry would go blank seconds after every
    // change and stay that way. The popup's switch is where that distinction belongs and it still
    // makes it; an icon has one job, which is to say what the workspace is doing.
    //
    // Named rather than pointed at: an icon given as a file path is loaded as a picture and keeps
    // the colour in the file, while a name goes through KIconLoader, which rewrites the
    // stylesheet in it with the colour scheme's text colour. The difference is a near-black icon
    // on a dark panel against one that follows it.
    Plasmoid.icon: !root.tilingEverKnown ? "kosmic-tiling-symbolic"
                                         : (root.tilingOn ? "kosmic-tiling-on-symbolic"
                                                          : "kosmic-tiling-off-symbolic")
    toolTipMainText: i18n("KOSMIC Tiling")
    toolTipSubText: i18n("Tiling controls for the current workspace")

    // The popup is the only time any of this is on screen, so it is the only time it is read --
    // and the only time the one thing that is polled is polled. A panel widget that keeps asking
    // about something nobody is looking at buys nothing and costs a subprocess every tick.
    onExpandedChanged: if (expanded) refresh()

    // Read once at startup as well, so the first popup opens with the chords already in place
    // rather than filling in a beat later.
    Component.onCompleted: {
        refresh()
        // Not part of refresh(): that one is a snapshot and runs again on every popup, while
        // this arms a wait that outlives the popup and must not be armed twice.
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

    // ---------- the bridge ----------

    Plasma5Support.DataSource {
        id: exec
        engine: "executable"
        connectedSources: []

        property var pending: ({})

        // One command in flight per command string: the engine keys its sources by the command
        // itself, so connecting the same string twice collapses into one source and the second
        // callback would never be reached.
        function run(cmd, callback) {
            if (pending[cmd] !== undefined) return
            pending[cmd] = callback || null
            connectSource(cmd)
        }

        onNewData: function (source, data) {
            disconnectSource(source)
            const cb = pending[source]
            delete pending[source]
            if (cb) cb(data["exit code"] === 0, String(data.stdout || "").trim())
        }
    }

    // `busctl --json=short` wraps both shapes as {"type":…,"data":…}, and the two are not the same
    // thing. For a *property* `data` is the value: reading `as` gives the array itself. For a
    // *call* `data` is the list of return values, so a `b` comes back as [false]. Reading a
    // property as if it were a call is what made the hint switch say "off" with the line on the
    // screen -- it was looking for "kosmic-outline" inside the string "shakecursor".
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

    // ---------- tiling ----------

    readonly property string invoke: "busctl --user call org.kde.kglobalaccel /component/kwin " +
                                     "org.kde.kglobalaccel.Component invokeShortcut s "

    // Ask, then read, in one shell command and in that order. Two exec.run calls would not do: the
    // data engine runs its sources concurrently, so the read would race the request and usually
    // win. The sequence is also the liveness check -- kosmic-stated expires what it holds, so a
    // value nobody refreshed comes back "unknown" instead of coming back stale.
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

    // Everything that learns the state comes through here, because the two readers disagree about
    // what "unknown" means and only one of them is right about it. `tilingOn` is the last state
    // actually reported and is never written from an expiry -- that is what lets the bar icon keep
    // saying what the workspace is doing while `tilingKnown` goes false under it and greys out the
    // switch.
    function takeTiling(value) {
        root.tilingKnown = (value === "on" || value === "off")
        if (!root.tilingKnown) return
        root.tilingOn = (value === "on")
        root.tilingEverKnown = true
    }

    // The long poll. kosmic-stated holds this call until the state changes and answers with the
    // new one, so the icon is right within a round trip of Meta+Y and nothing is spent in
    // between: no timer, no subprocess, one `busctl` asleep on a reply.
    //
    // The alternative was tried on the running session and is written up in state/tiling.h --
    // `busctl --user monitor | grep -m1` blocks correctly and then does not return, because grep
    // leaving does not reach busctl until busctl next writes. A real change took 5.9 seconds to
    // come out of that pipe.
    //
    // --timeout has to beat kosmic-stated's own window, which is ten minutes: whichever expires
    // first decides how often this re-arms, and a `busctl` default of 25 seconds would quietly
    // turn the long poll back into a poll.
    readonly property string watchCommand:
        "busctl --user --timeout=660 --json=short call " + stateService + " " + statePath + " " +
        stateIface + " WaitForChange"

    function watchTiling() {
        exec.run(root.watchCommand, function (ok, out) {
            if (!ok) {
                // Nobody is answering: the service is not running, or not yet. Re-arming straight
                // away would spin as fast as a process can be started, which is the one way this
                // could cost more than the polling it replaces.
                watchRetry.restart()
                return
            }
            let v = null
            try { v = JSON.parse(out).data[0] } catch (e) { v = null }
            root.takeTiling(v)
            root.watchTiling()
        })
    }

    Timer {
        id: watchRetry
        interval: 5000
        onTriggered: root.watchTiling()
    }

    function toggleTiling() {
        // kglobalaccel rather than KWin: the tiler owns the behaviour and already has it bound, so
        // invoking the shortcut is the one path that cannot disagree with what Meta+Y does. It
        // acts on the focused space, which with two monitors is not necessarily the space of the
        // screen this panel is on.
        exec.run(root.invoke + root.toggleShortcut, function () { root.readTiling() })
    }

    // While the popup is open, and only then. This is not what keeps the state current any more --
    // the long poll above does that, and it does it with the popup shut too. What this is for is
    // the *freshness*: kosmic-stated expires what it holds, by design, and `tilingKnown` is what
    // the switch uses to decide whether it may claim anything at all. Only a forced publish
    // refreshes that, and only this asks for one, so the interval has to stay well inside the
    // expiry or an idle popup would watch its own switch grey out between refreshes.
    Timer {
        id: tilingPoll
        interval: 2000
        repeat: true
        running: root.expanded
        onTriggered: root.readTiling()
    }

    // ---------- new workspace behaviour ----------

    function readNewWorkspace() {
        exec.run("kreadconfig6 --file kwinrc --group " + root.scriptGroup + " --key NewWorkspaceTiled",
                 function (ok, out) { root.newWorkspaceTiled = !ok || out !== "false" })
    }

    function setNewWorkspace(tiled) {
        // Written and then announced, and the announcement is not `reconfigure`. A KWin script
        // reads its configuration when it loads, and the global reconfigure does not reach one --
        // measured: the key went to false and the next workspace still came up tiled. So the write
        // is what survives the session, and the shortcut is what tells the tiler now. It is the
        // same path chordhold/ uses to call KosmicSwapArm, for the same reason.
        exec.run("kwriteconfig6 --file kwinrc --group " + root.scriptGroup +
                 " --key NewWorkspaceTiled " + (tiled ? "true" : "false") + " && " + root.invoke +
                 (tiled ? "KosmicNewWorkspaceTiled" : "KosmicNewWorkspaceFloating"),
                 // The tiler republishes when this lands, because the default it just moved is the
                 // answer for every workspace that has nothing open on it -- including, often,
                 // this one.
                 function () { root.readNewWorkspace(); root.readTiling() })
    }

    // ---------- active hint ----------

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
            // Turning it back on restores what was *configured*, not everything that is installed.
            // The package ships both halves whatever the options say -- `focusDim.enable = false`
            // only writes the kwinrc key -- so loading every available piece would switch on
            // something the configuration had turned off. kreadconfig6 reads the same merge of
            // /etc/xdg and ~/.config that KWin reads, which is where that answer lives.
            exec.run("kreadconfig6 --file kwinrc --group Plugins --key " + p.id + "Enabled",
                     function (ok, out) {
                         if (!ok || out !== "true") return
                         if (p.id !== "kosmic-outline") {
                             dbusCall(p.object, p.iface, p.load, p.id)
                             return
                         }
                         // Load and then nudge, in one command and in that order. Same reason as
                         // setOutline: a plugin that has just been constructed knows nothing about
                         // the selection, and the tiler will not say it again on its own. Two
                         // exec.run calls would not do -- the data engine runs its sources
                         // concurrently, so the nudge could arrive before the plugin is listening.
                         // The effect needs no nudge at all: it reads a window already in place.
                         exec.run("busctl --user call org.kde.KWin " + p.object + " " + p.iface +
                                  " " + p.load + " s " + p.id + " >/dev/null; " +
                                  root.invoke + root.reloadShortcut)
                     })
        }
        // The writes are asynchronous and KWin's properties emit their own change, so the switch is
        // told by the read-back rather than by the click. Nothing here assigns `checked`.
        hintRecheck.restart()
    }

    Timer {
        id: hintRecheck
        interval: 400
        onTriggered: root.readHint()
    }

    // ---------- the line's thickness and colour ----------

    // Both in one shell round trip, for the reason readChords gives: two sources are two processes
    // the popup would then have to join.
    function readOutline() {
        exec.run("for k in Thickness Color; do echo \"$k=$(kreadconfig6 --file kwinrc --group " +
                 root.outlineGroup + " --key $k)\"; done",
                 function (ok, out) {
                     if (!ok) return
                     for (const line of out.split("\n")) {
                         const at = line.indexOf("=")
                         if (at < 0) continue
                         const k = line.slice(0, at), v = line.slice(at + 1).trim()
                         if (k === "Thickness") {
                             const n = parseInt(v, 10)
                             // The plugin's own default, not zero: an unset key reads empty here
                             // and a 0px line is indistinguishable from the hint being off.
                             // settings.json: kosmic-outline.Thickness
                             root.hintThickness = isNaN(n) || n < 1 ? 3 : n
                         } else if (k === "Color") {
                             root.hintColor = v
                         }
                     }
                 })
    }

    // What the dialog hands back, in the spelling the key is written in. Not String(colour),
    // which Qt spells "#rrggbb" for an opaque colour and "#aarrggbb" for a translucent one -- a
    // difference the dialog is free to produce and the plugin's QColor would happily accept,
    // leaving an eight-digit value where every other thing that touches this key writes six.
    // Reading the channels makes the spelling this module's own.
    function hexOf(c) {
        function two(v) { return ("0" + Math.round(v * 255).toString(16)).slice(-2) }
        return "#" + two(c.r) + two(c.g) + two(c.b)
    }

    // Write, then make the plugin read it. It does that in its constructor, with a KConfig of its
    // own rather than the shared one KWin is holding -- which is exactly what makes unload-load a
    // working reload rather than a no-op. Only when it is actually up: loading a plugin that was
    // off would turn the hint on as a side effect of changing how it looks.
    //
    // And then KosmicReloadSettings, which is not about settings here. A plugin that has just been
    // constructed does not know what the selection is: the tiler pushes that over D-Bus and will
    // not push it again until it changes. Without this the thickness would apply and the line
    // would be missing until the user moved the focus.
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

    // ---------- the gaps ----------

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

    // Three steps, in this order, in one command. The write is what survives the session. The
    // reconfigure is what makes the value reachable at all: it does not reach a script -- there is
    // no hook and nothing re-runs -- but it makes KWin drop the configuration it hands one back,
    // and without it the tiler would re-read the same numbers it already had. Measured with a
    // probe script: read, change the key, read again (unchanged), reconfigure, read again (new).
    // The shortcut is what tells the tiler to read.
    function setGaps(inner, outer) {
        exec.run("kwriteconfig6 --file kwinrc --group " + root.scriptGroup + " --key GapInner " + inner +
                 " && kwriteconfig6 --file kwinrc --group " + root.scriptGroup + " --key GapOuter " + outer +
                 " && busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure >/dev/null" +
                 " && " + root.invoke + root.reloadShortcut,
                 function () { root.readGaps() })
    }

    // A spin box fires on every click of its arrow, and each one here is three processes and a
    // relayout of every workspace -- or, for the line, a plugin unloaded and loaded. The write
    // waits for the clicking to stop.
    //
    // These two are also the only controls in the popup whose displayed value is driven by the
    // click rather than by the read-back. That is deliberate and it is the difference between a
    // switch and a spin box: a switch snapping back for the fraction of a second it takes to read
    // kwinrc reads as "it did not take", while a spin box doing it on every arrow click cannot be
    // used at all. The read-back still runs and still wins; it simply arrives later.
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

    // ---------- the colour picker ----------

    // A panel popup closes when it loses focus, and a dialog is a window of its own: opening one
    // takes the focus and the popup goes with it, taking the dialog's parent down too. Holding
    // the popup open for as long as the dialog is up is all these two do.
    //
    // The release is the awkward half, and it is why there is a Connections block beside the
    // button rather than an onRejected handler. The dialog is no longer this file's: it belongs
    // to Vendor.ColorButton, which exposes `accepted` and nothing for the other way out,
    // so a cancelled dialog would leave the popup pinned open for the rest of the session. What
    // is watched instead is the popup window going active again, which both ways out produce --
    // the dialog closing hands the focus back whether it was accepted or not. releasePopup is a
    // plain assignment, so accepted and that edge firing together costs nothing.
    function pinPopup() {
        Plasmoid.hideOnWindowDeactivate = false
    }
    function releasePopup() {
        Plasmoid.hideOnWindowDeactivate = true
    }

    // ---------- shortcuts ----------

    // Read from kglobalaccel's own store rather than printed as constants. The chords are
    // generated from keybindings.json and `chordHold` moves one of them, so a literal here would be
    // a fourth copy of the keymap -- the thing that file exists to make unrepresentable.
    function readChords() {
        const names = ["KosmicFocusLeft", "KosmicFocusRight", "KosmicFocusUp", "KosmicFocusDown",
                       "KosmicMoveWindowLeft", "KosmicMoveWindowRight", "KosmicMoveWindowUp",
                       "KosmicMoveWindowDown", "KosmicFloating"]
        // One shell round trip for all nine. kreadconfig6 rather than a grep of the file because
        // only it applies the XDG merge; the loop is in the shell so the popup does not pay for
        // nine separate processes it would then have to join.
        exec.run("for k in " + names.join(" ") + "; do echo \"$k=$(kreadconfig6 --file " +
                 "kglobalshortcutsrc --group kwin --key $k)\"; done",
                 function (ok, out) {
                     if (!ok) return
                     const got = {}
                     for (const line of out.split("\n")) {
                         const at = line.indexOf("=")
                         if (at < 0) continue
                         // kglobalshortcutsrc stores "active,default,friendly name"; the active
                         // sequence is the first field and is what the user actually presses.
                         got[line.slice(0, at)] = line.slice(at + 1).split(",")[0].trim()
                     }
                     root.focusChord = family([got.KosmicFocusLeft, got.KosmicFocusRight,
                                               got.KosmicFocusUp, got.KosmicFocusDown])
                     root.moveChord = family([got.KosmicMoveWindowLeft, got.KosmicMoveWindowRight,
                                              got.KosmicMoveWindowUp, got.KosmicMoveWindowDown])
                     root.floatChord = got.KosmicFloating || ""
                 })
    }

    // COSMIC prints a family as one line -- "Super + arrows" -- and the four chords here only read
    // that way while they share a modifier. If one has been rebound out of the family, say the one
    // rather than a prefix none of them has.
    function family(chords) {
        const valid = chords.filter(function (c) { return c && c.length })
        if (!valid.length) return ""
        const prefixOf = function (c) { const p = c.split("+"); p.pop(); return p.join("+") }
        const first = prefixOf(valid[0])
        if (!first.length) return valid[0]
        for (const c of valid) if (prefixOf(c) !== first) return valid[0]
        return first + "+" + i18n("arrows")
    }

    // ---------- the popup ----------


    // One padded column, with no header band and no footer band, because that is the shape
    // cosmic-applet-tiling has: its popup opens straight on the first control and closes on the
    // settings button, with dividers between the groups and no chrome of its own. It also removes
    // a whole class of sizing bug -- a PlasmoidHeading whose content is anchored reports no
    // implicit height, so a popup measured from header + content + footer comes out one row short
    // and draws the band over the last control.
    fullRepresentation: PlasmaExtras.Representation {
        id: popup

        Layout.minimumWidth: Kirigami.Units.gridUnit * 20
        Layout.maximumWidth: Kirigami.Units.gridUnit * 26
        // Measured from the Page, which only reports a content height once the column is its
        // `contentItem` rather than a loose child. As a loose child the Page kept answering 16 --
        // its own padding -- and the popup came out short enough to clip the last two rows.
        Layout.minimumHeight: implicitHeight
        Layout.preferredHeight: implicitHeight


        // Upstream's rhythm, which is three numbers and one deliberate asymmetry. libcosmic pads
        // every row by `menu_control_padding()` -- space_xxs vertical, space_m horizontal
        // (src/applet/mod.rs:614-626) -- and every divider by [space_xxs, space_s] instead
        // (cosmic-applet-tiling/src/window.rs). With space_xxs 8, space_s 16 and space_m 24
        // (cosmic-theme/src/model/spacing.rs:32-36) that is 1 : 2 : 3, which Kirigami's
        // largeSpacing reproduces exactly and which scales with the session where three
        // hardcoded pixel counts would not.
        //
        // The asymmetry is the signature: a divider is inset 16 where the row above it is inset
        // 24, so the line overshoots the content by 8 on each side. That is done here by padding
        // the popup to the *divider's* inset and giving every row the remaining 8 -- rather than
        // padding to the row's and pulling the dividers back out with negative margins, which
        // would rest on nothing above this ever setting `clip`.
        readonly property int rowInset: Kirigami.Units.largeSpacing

        leftPadding: Kirigami.Units.largeSpacing * 2
        rightPadding: Kirigami.Units.largeSpacing * 2
        topPadding: Kirigami.Units.largeSpacing * 2
        bottomPadding: Kirigami.Units.largeSpacing * 2

        collapseMarginsHint: true

        contentItem: ColumnLayout {
            id: contents
            // Upstream has no column spacing at all: every gap there is two paddings meeting, 8
            // from the control above and 8 from the one below. One spacing of 16 is the same
            // picture without repeating it on every row.
            spacing: Kirigami.Units.largeSpacing * 2

            // Upstream's toggler, in upstream's position. It reads the workspace the *keyboard* is
            // on rather than the one this panel is on, which with two monitors is not always the
            // same -- the tiler decides that, and this shows what the tiler decided.
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
                    // Disabled rather than guessing, and the row stays the same height either way
                    // so the popup cannot be measured for one and then shown as the other.
                    enabled: root.tilingKnown
                    // Same as the two below: the switch moves when the tiler says it moved, not
                    // when it is pressed. Restoring the binding is what keeps that true -- a
                    // Switch writes its own `checked` on click, which would replace the binding
                    // with a literal and leave the control showing the click.
                    onClicked: {
                        checked = Qt.binding(function () { return root.tilingOn })
                        root.toggleTiling()
                    }
                }
            }

            Kirigami.Separator {
                // No margins of its own: the column already spaces every child by two of upstream's
                // paddings, and this is the one child that stays at the popup's own inset while the
                // rows beside it step in by another 8. That overhang is the divider.
                Layout.fillWidth: true
            }

            // "New workspace behavior", on one row with its control, the way Thickness and the
            // two gaps are. It was a label above a full-width strip drawn here out of a Rectangle
            // and a Repeater -- a translation of COSMIC's `SegmentedButton::Control`, with its
            // radius_xl container, which in a Plasma popup read as a pill nothing else in KDE
            // has.
            //
            // KDE turns out to have the control itself: org.kde.kirigamiaddons.components'
            // SegmentedButton, buttons joined into one block with the outer corners rounded by
            // mediumSpacing and the inner ones square. The same object as COSMIC's, at KDE's
            // radius and KDE's height, carrying its own focus ring, hover and pressed states
            // instead of the three alpha tints that were invented here to stand in for them.
            //
            // It sizes to its content rather than filling the row, which is why the label moved
            // beside it: a natural-width control under a full-width label would sit in a gap of
            // its own making.
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

            // The two halves, and the reason they are Actions and not two buttons is that
            // SegmentedButton takes `actions` and builds its own delegates from them -- which is
            // the whole point of using it rather than joining buttons by hand.
            //
            // `checked` goes through a Binding rather than a plain assignment. A checkable Action
            // toggles its own `checked` when triggered, and that write replaces an ordinary
            // binding for good: after the first click the strip would show what the action last
            // did instead of what the key says, and the two would part company the moment a write
            // failed. A Binding object re-asserts after the toggle, so the strip stays a read-back
            // of the configuration and nothing else -- the same rule the rest of this popup
            // follows.
            Kirigami.Action {
                id: newWorkspaceTiledAction
                text: i18n("Tiled")
                checkable: true
                // Clicking the half that is already current is a no-op rather than a rewrite: the
                // old strip guarded this with `if (segment.current) return`, and an Action fires
                // on every click, selected or not.
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
                // No margins of its own: the column already spaces every child by two of upstream's
                // paddings, and this is the one child that stays at the popup's own inset while the
                // rows beside it step in by another 8. That overhang is the divider.
                Layout.fillWidth: true
            }

            // Label on the left, chord on the right, the way COSMIC lays its three out and the way
            // every shortcut list in KDE does.
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
                    // Always present, never hidden on an empty chord. The chords arrive from a
                    // subprocess, so hiding the rows until then makes the popup grow by three rows
                    // after it has already been sized -- and the dialog does not grow with it,
                    // which clipped the last two controls off the bottom.

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
                // No margins of its own: the column already spaces every child by two of upstream's
                // paddings, and this is the one child that stays at the popup's own inset while the
                // rows beside it step in by another 8. That overhang is the divider.
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
                    // Same reason as the segmented buttons above: the switch moves when KWin says
                    // it moved, not when it is pressed.
                    onClicked: {
                        const want = checked
                        checked = Qt.binding(function () { return root.hintOn })
                        root.setHint(want)
                    }
                }
            }

            // How the line looks. cosmic-settings calls this "Active window hint size" and puts it
            // on the Appearance page; it is here because the line is a KWin plugin, a plugin has
            // no `contents/config`, and therefore no dialog can be built for it at all -- without
            // this the only way to change the thickness is a rebuild and a logout.
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
                    // Upstream's range is 0 to 64 and this one starts at 1, because upstream's 0
                    // is a second way of saying what the switch above already says. A hint that
                    // can be off twice, with the two answers able to disagree, is a worse control
                    // than one that cannot.
                    from: 1
                    to: 64
                    value: root.hintThickness
                    onValueModified: {
                        root.hintThickness = value
                        // The gap comes up with the line, which is what cosmic-settings does when
                        // the hint size passes the gap (theme_manager.rs:696). The line lives in
                        // the gap; a gap narrower than the line has nowhere to draw it.
                        if (root.gapInner < value) {
                            root.gapInner = value
                            gapWrite.restart()
                        }
                        outlineWrite.restart()
                    }
                }
            }

            // Pop Shell's row, which is where this control belongs and where COSMIC's does not
            // exist. cosmic-applet-tiling has no colour in its popup at all, because
            // cosmic-settings has a page for it; `pop-os/shell` has no such page either -- the
            // same position this module is in -- and put "Active Hint Color" straight in the panel
            // menu as a label and one swatch that opens a picker (src/panel_settings.ts:337).
            // That is this row.
            //
            // What the swatch opens is not Pop Shell's: it spawns a separate gjs process running
            // a Gtk.ColorChooserDialog. Here the dialog belongs to the applet, which is why the
            // popup has to be pinned open while it is up.
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

                // Shown only when there is something to go back from. Pop Shell cannot offer this
                // at all -- its colour is always a stored literal, so "the theme's" is not a state
                // it has -- and COSMIC spends a whole toggler on it. One button that appears when
                // it has work to do costs neither a row nor a permanent control that is usually a
                // no-op.
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

                // KDE's own colour button, from org.kde.kquickcontrols: a framed button with the
                // colour inset in it by four pixels, which is what System Settings puts beside
                // every entry in the scheme editor. This was a Rectangle drawn here with a border
                // faked out of the text colour at 0.3 -- a swatch, not a control: no frame, no
                // pressed state, no focus ring, and a hand cursor bolted on to say it was
                // clickable at all. The dialog it opens is the same QtQuick.Dialogs.ColorDialog
                // this file used to own, because that is what ColorButton wraps.
                //
                // It shows what is actually being drawn and not what is written: an empty key
                // means the colour scheme's accent, so that is what it has to show, or the one
                // state the module ships in would be the one state with nothing in the square.
                // Kirigami.Theme.highlightColor is the value the plugin resolves to -- the
                // scheme's selection background, tinted by any accent Plasma is applying.
                Vendor.ColorButton {
                    id: hintColorButton
                    // Six hex digits is what the key holds everywhere else in this file, and an
                    // alpha slider would be a control for a seventh and an eighth that nothing
                    // here can write or read back.
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
                    // `color` is an alias straight onto the dialog's selectedColor, so the dialog
                    // writes it, and a write replaces an ordinary binding for good: after one pick
                    // the undo arrow would clear the key and leave the old colour sitting in the
                    // button. A Binding object re-asserts instead of being replaced.
                    Binding {
                        target: hintColorButton
                        property: "color"
                        value: root.hintColor.length > 0 ? root.hintColor
                                                         : Kirigami.Theme.highlightColor
                    }
                    // The other half of pinPopup -- see the comment on it. The window goes
                    // inactive when the dialog takes the focus, so the edge that matters is the
                    // one back to active.
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
                // No margins of its own: the column already spaces every child by two of upstream's
                // paddings, and this is the one child that stays at the popup's own inset while the
                // rows beside it step in by another 8. That overhang is the divider.
                Layout.fillWidth: true
            }

            // The gaps, which upstream's `.ftl` names and upstream's `view()` never renders --
            // COSMIC keeps them in cosmic-settings, writing the one config file the compositor
            // watches, so there they apply as they move. The equivalent dialog here writes a key
            // the running script will not read until the next login, which made the one setting
            // people actually reach for the slowest to try. See setGaps for the three steps that
            // make these apply now.
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
                    // The hint's thickness is the floor, which is cosmic-settings' own range for
                    // this spin (appearance/mod.rs:837) and is there because the line is drawn in
                    // this gap. Only while the hint is up: with it off nothing is drawn in the gap
                    // and a thickness nobody can see has no business setting a minimum.
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
                    // Upstream's pair is (outer, inner) and outer is an extra edge gap on top of
                    // the inner one, defaulting to 0 -- at 0 a screen edge and a seam are the same
                    // width, which is what a tiled desktop looks like. Named for what it does
                    // rather than for the field it writes.
                    text: i18n("Extra gap at screen edges")
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                }
                PlasmaComponents.SpinBox {
                    // No floor, unlike the one above: this gap is added to that one, so the line
                    // already has the room it needs before this is counted. The ceiling is the
                    // same because the two are added and a pair with different limits would make
                    // the sum's limit a thing nobody can read off either box.
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
                // No margins of its own: the column already spaces every child by two of upstream's
                // paddings, and this is the one child that stays at the popup's own inset while the
                // rows beside it step in by another 8. That overhang is the divider.
                Layout.fillWidth: true
            }

            // COSMIC closes its popup with the way into the settings. KDE has no window-management
            // page for this -- KOSMIC's settings are the script's own dialog and the generic
            // dialog has no deep link -- so this opens the list that holds it.
            // `menu_button`, which is what upstream ends its popup with and is a different thing
            // from a push button: `button::custom(content).class(Button::AppletMenu).padding(
            // menu_control_padding()).width(Length::Fill)` (src/applet/mod.rs:605-612) -- full
            // width, the menu padding every row above it uses, and content at the leading edge.
            // So no icon and no centring here either. The highlight it grows on hover is the
            // popup's own width rather than the text's, the way a menu entry's is, which is why
            // this one child keeps the divider's inset and takes the remaining 8 as padding
            // instead of as a margin.
            PlasmaComponents.Button {
                id: settingsButton
                text: i18n("Window management settings…")
                flat: true
                Layout.fillWidth: true
                leftPadding: popup.rowInset
                rightPadding: popup.rowInset
                // By id and not by `parent`: a contentItem's parent is the control, so `parent`
                // would resolve, but only at run time and only if nothing ever reparents it.
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
