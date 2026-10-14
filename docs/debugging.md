# Debugging

Where to look when KOSMIC does not behave. Everything below was read from the code; nothing here
needs a tool beyond what a Plasma session already has.

## Trace to the journal

The script prints a line when it loads, and logs geometry changes when `Debug` is on:

```sh
kwriteconfig6 --file kwinrc --group Script-kosmic-tiling --key Debug true
qdbus org.kde.KWin /KWin reconfigure
```

Each effect has its own `Debug` key under `Effect-kosmic-tiling-anim` and `Effect-kosmic-focusdim`; the outline plugin has one under `Plugin-kosmic-outline`.
KWin's output goes to the user journal:

```sh
journalctl --user -b | grep -iE "kosmic|RangeError|Maximum call stack"
```

A tree repair the script makes (a window reference that was in the wrong place) is logged whether
or not `Debug` is on.

## The state service

The applet's tiling switch reads `kosmic-stated`:

```sh
systemctl --user status kosmic-stated
busctl --user get-property io.github.eduresser.kosmic /Tiling io.github.eduresser.kosmic.Tiling State
```

An answer means the script is publishing; no answer means the service is down or the script is
not loaded, and the switch opens disabled.

## The compiled plugins

KWin's plugin API has no binary compatibility, so `kosmic-chordhold` and `kosmic-outline` have to be
rebuilt after a KWin update. Whether KWin has loaded the chord plugin right now:

```sh
busctl --user get-property org.kde.KWin /Plugins org.kde.KWin.Plugins LoadedPlugins | grep kosmic
```

`install.sh` writes `QT_PLUGIN_PATH` for the session as a file under
`~/.config/environment.d/`, and it takes effect at the next login. Re-running `./install.sh` after
a KWin update rebuilds the plugins and says so when the version changed.

## Trying the script without installing

```sh
tools/try.sh            # load src/comp/script into the running KWin
tools/try.sh --stop     # unload it
```
