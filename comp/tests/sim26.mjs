// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// The keymap, checked against COSMIC's own data/keybindings.ron rather than against a reading of
// it. The fixture beside this file is that file verbatim, so a chord upstream adds or moves fails
// here instead of drifting quietly.
//
// What is being checked is keybindings.json, which is the single source every
// other copy is generated from: the QML shortcut model the script instantiates, and the
// kglobalshortcutsrc entries kglobalaccel needs. Before that file existed those were three
// hand-written copies, and they had drifted into fifteen missing shortcuts and twenty-eight
// stale ones.
//
// The test parses the .ron, drops everything out of scope — System(...) actions that are KDE's
// job, Terminate and Debug, and the zoom bindings that are out of scope — and then requires
// the JSON to account for every remaining chord exactly once, with the same action. "Account for"
// is two things: bind it, or decline it by name under `divergences` with the reason beside it.
// The second is what keeps a deliberate difference from reading like an oversight, and it is
// checked as hard as a binding is — a declined chord has to be one COSMIC really has, and must
// not also be bound.
//
// What that catches, and what a hand-written table gets wrong on its own:
//   - a chord present upstream and neither bound nor declined here
//   - a chord here that upstream does not have
//   - the same chord claimed twice
//   - an action bound to the wrong chord
//
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ron = fs.readFileSync(path.join(here, 'fixtures', 'keybindings.ron'), 'utf8');

// The keymap is the second argument. It is passed rather than found because it lives at the
// repository root while the tiler lives four directories down, and resolving one from the other
// only holds for a full checkout — not for a package extracted on its own.
const keymapPath = process.argv[3]
    || path.resolve(path.dirname(process.argv[2]), '..', '..', '..', '..', 'keybindings.json');
const keymap = JSON.parse(fs.readFileSync(keymapPath, 'utf8'));
const { bindings, additions } = keymap;
const divergences = keymap.divergences || [];

const KOSMIC = 'kosmic', KDE = 'kde';

// ---------- parse the fixture ----------
//
// Lines look like:  (modifiers: [Super, Shift], key: "h"): Move(Left),
// and one has no key at all:  (modifiers: [Super]): System(Launcher),
const LINE = /^\s*\(modifiers:\s*\[([^\]]*)\](?:,\s*key:\s*"([^"]*)")?\):\s*(.+?),?\s*$/;

const MOD_NAME = { Super: 'Meta', Shift: 'Shift', Ctrl: 'Ctrl', Alt: 'Alt' };
// KWin writes a chord with its modifiers in a fixed order, so normalise rather than compare the
// order the .ron happens to use.
const MOD_ORDER = ['Meta', 'Ctrl', 'Shift', 'Alt'];

function chordOf(mods, key) {
    const names = mods
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
        .map((m) => MOD_NAME[m] || m);
    names.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));

    if (!key) return names.join('+');
    // The .ron writes xkb key names; KWin writes its own spelling. A single letter goes
    // uppercase, and an all-lowercase name is capitalised — "period" is "Period" in a KWin
    // shortcut. Names that already carry case (Left, F11, XF86AudioPlay) are left alone.
    let k = key;
    if (k.length === 1) k = k.toUpperCase();
    else if (/^[a-z]+$/.test(k)) k = k[0].toUpperCase() + k.slice(1);
    return names.concat(k).join('+');
}

const upstream = [];
for (const line of ron.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    upstream.push({ chord: chordOf(m[1], m[2]), action: m[3].trim() });
}

assert.ok(upstream.length > 80, `the fixture parsed to only ${upstream.length} bindings`);

// ---------- what is in scope ----------

const OUT_OF_SCOPE = (b) =>
    b.action.startsWith('System(') ||   // launcher, terminal, screenshot, volume: KDE's already
    b.action === 'Terminate' ||
    b.action === 'Debug' ||
    b.action === 'ZoomIn' ||            // zoom.rs is out of scope
    b.action === 'ZoomOut';

const inScope = upstream.filter((b) => !OUT_OF_SCOPE(b));
assert.ok(inScope.length > 60, `only ${inScope.length} bindings in scope, expected far more`);

// Sanity: the filter is dropping the things it should and nothing else.
const dropped = upstream.filter(OUT_OF_SCOPE).map((b) => b.action);
assert.ok(dropped.includes('System(Launcher)'));
assert.ok(dropped.includes('ZoomIn'));
assert.ok(!dropped.some((a) => a.startsWith('Focus(')), 'focus is never out of scope');
assert.ok(!dropped.some((a) => a.startsWith('Move(')), 'neither is move');

// ---------- the file covers exactly the in-scope chords ----------

const byChord = new Map();
for (const e of bindings) {
    assert.ok(!byChord.has(e.chord), `${e.chord} is claimed twice in keybindings.json`);
    byChord.set(e.chord, e);
}

// A chord may be left unanswered, but only out loud. `divergences` is that register: every entry
// has to name a chord COSMIC really has, has to carry its reason, and must not also be bound --
// otherwise "we decided not to" and "we bound it anyway" would both be true of the same key.
const declined = new Map();
for (const d of divergences) {
    assert.ok(!declined.has(d.chord), `${d.chord} is declined twice`);
    declined.set(d.chord, d);
    assert.ok(d.action, `the divergence on ${d.chord} names no action`);
    assert.ok(Array.isArray(d.why) && d.why.join(' ').length > 120,
        `the divergence on ${d.chord} needs its reason written down, not a sentence`);
    assert.ok(!byChord.has(d.chord), `${d.chord} is declined and bound at the same time`);
    const up = upstream.find((b) => b.chord === d.chord);
    assert.ok(up, `${d.chord} is declined, but COSMIC does not bind it -- there is nothing to decline`);
    assert.equal(up.action, d.action,
        `${d.chord} is declined as ${d.action}, but upstream binds it to ${up.action}`);
    assert.ok(!OUT_OF_SCOPE(up),
        `${d.chord} is out of scope already; listing it here claims a decision that was never made`);
}

const missing = [];
const wrongAction = [];
for (const b of inScope) {
    const e = byChord.get(b.chord);
    if (!e) { if (!declined.has(b.chord)) missing.push(`${b.chord} -> ${b.action}`); continue; }
    if (e.action !== b.action) wrongAction.push(`${b.chord}: upstream ${b.action}, file ${e.action}`);
}
assert.deepStrictEqual(missing, [],
    'chords in keybindings.ron that the file neither answers nor declines under "divergences"');
assert.deepStrictEqual(wrongAction, [], 'chords bound to a different action than upstream');

const upstreamChords = new Set(inScope.map((b) => b.chord));
const invented = bindings.filter((e) => !upstreamChords.has(e.chord)).map((e) => e.chord);
assert.deepStrictEqual(invented, [],
    'chords in the file that COSMIC does not have — those belong under "additions"');

// ---------- every entry is well formed ----------

for (const e of bindings) {
    assert.ok(e.owner === KOSMIC || e.owner === KDE, `${e.chord} has no owner`);
    if (e.owner === KOSMIC) {
        assert.ok(e.name && e.name.startsWith('Kosmic'),
            `${e.chord} is ours but has no Kosmic shortcut name`);
        assert.ok(e.handler, `${e.chord} is ours but names no handler`);
        assert.ok(e.text, `${e.chord} is ours but has no label for System Settings`);
    } else {
        assert.ok(!e.name, `${e.chord} is KDE's and should not name a shortcut`);
        assert.ok(!e.handler, `${e.chord} is KDE's and should not name a handler`);
    }
}

for (const e of additions) {
    assert.ok(e.name && e.name.startsWith('Kosmic'), `${e.chord} needs a Kosmic shortcut name`);
    assert.ok(e.handler && e.text, `${e.chord} needs a handler and a label`);

    // An addition justifies itself, or it belongs to a mode that is justified once. Nine keys
    // of one mode repeating the same paragraph would be worse than a reference, but a bare
    // reference to a mode that does not exist is no justification at all.
    if (e.modal) {
        assert.ok(keymap.modes && keymap.modes[e.modal],
            `${e.chord} claims mode "${e.modal}", which is not documented under modes`);
    } else {
        assert.ok(e.why && e.why.length > 40,
            `${e.chord} is a standalone addition and needs its own justification`);
    }
}

// Every documented mode is reachable, and none of them registers keys of its own.
//
// A mode used to carry a second set of entries holding the same chords as Focus, bound only while
// it was active. That cannot work: this file is written into kglobalshortcutsrc as `none` for
// exactly those names -- they must not hold the chord when the mode is off -- and the stored value
// wins over the QML default, so they were unbound in every mode. The arrows stay with Focus and
// the mode reinterprets them in the script, which means a `modal` entry here is a mistake.
for (const [name, mode] of Object.entries(keymap.modes || {})) {
    assert.ok(!additions.some((e) => e.modal === name),
        `mode "${name}" registers keys of its own; a chord already taken cannot be bound twice`);
    assert.ok(Array.isArray(mode.arm) && mode.arm.length > 0, `mode "${name}" is never armed`);
    for (const a of mode.arm) {
        assert.ok(bindings.some((b) => b.action === a),
            `mode "${name}" is armed by ${a}, which is not a binding`);
    }
    assert.ok(mode.why, `mode "${name}" has no reason written down`);

    // A mode that can be held names the three pieces the plugin needs, and all three have to
    // exist: the toggle whose chord it takes over, and the two invoke-only names it drives.
    // tools/gen.mjs reads this block twice -- once for install.d/chordhold.ini, once for the
    // chordhold half of install.d/silenced.txt -- so a name that is wrong here is wrong in two
    // places at once, and in a way neither of them can notice.
    if (!mode.hold) continue;
    const all = bindings.concat(additions);
    const toggle = all.find((e) => (e.handler || '') === mode.hold.toggle);
    assert.ok(toggle, `mode "${name}" is held by handler "${mode.hold.toggle}", which binds nothing`);
    assert.ok(toggle.name, `the toggle of mode "${name}" has no shortcut name to stand down`);
    assert.ok(!toggle.invokeOnly,
        `the toggle of mode "${name}" takes no key, so there is nothing for a hold to replace`);
    for (const half of ['arm', 'commit']) {
        const e = all.find((x) => x.name === mode.hold[half]);
        assert.ok(e, `mode "${name}" is held through ${mode.hold[half]}, which is not a shortcut`);
        assert.ok(e.invokeOnly,
            `${mode.hold[half]} is driven by the plugin and must take no key of its own`);
    }
    assert.notStrictEqual(mode.hold.arm, mode.hold.commit,
        `mode "${name}" arms and ends through the same name`);
}

// The chords a held mode takes over have to be something the plugin can actually watch: it reads
// evdev scan codes, which name key *positions*, and it keeps one modifier and one key per chord.
// tools/gen.mjs throws on anything else, which fails the generator rather than producing a chord
// that never arms -- this is the same check, early enough to name the mode.
{
    const MODS = ['Meta', 'Ctrl', 'Alt', 'Shift'];
    for (const [name, mode] of Object.entries(keymap.modes || {})) {
        if (!mode.hold) continue;
        const toggle = bindings.concat(additions).find((e) => (e.handler || '') === mode.hold.toggle);
        const parts = toggle.chord.split('+');
        assert.strictEqual(parts.filter((p) => MODS.includes(p)).length, 1,
            `mode "${name}" is held on "${toggle.chord}", which is not exactly one modifier`);
        assert.strictEqual(parts.filter((p) => !MODS.includes(p)).length, 1,
            `mode "${name}" is held on "${toggle.chord}", which is not exactly one key`);
    }
}

// Shortcut names are unique. Two entries sharing one would leave the second unreachable, and
// kglobalaccel would not complain.
{
    const names = bindings.filter((e) => e.name).map((e) => e.name)
        .concat(additions.map((e) => e.name));
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepStrictEqual(dup, [], 'a shortcut name is used twice');
}

// ---------- the split between KOSMIC and KDE is the one that was argued for ----------

const ours = new Set(bindings.filter((e) => e.owner === KOSMIC).map((e) => e.action));
for (const a of ['Focus(Left)', 'Focus(In)', 'Focus(Out)', 'Move(Left)', 'SwapWindow',
                 'ToggleOrientation', 'ToggleStacking', 'ToggleTiling', 'ToggleWindowFloating',
                 'Resizing(Outwards)']) {
    assert.ok(ours.has(a), `${a} needs the tree, so it has to be ours`);
}

// Stepping past the last workspace has to *create* one, which is the whole point of the
// dynamic workspace policy and something KWin's own next-desktop will not do. So these are
// ours despite looking like plain desktop switching.
for (const a of ['NextWorkspace', 'PreviousWorkspace',
                 'MoveToNextWorkspace', 'MoveToPreviousWorkspace']) {
    assert.ok(ours.has(a), `${a} has to create a workspace on demand, so it is ours`);
}

// KWin has "Switch to Desktop N" for a fixed N and nothing for "the last one", which moves as the
// list grows and shrinks. So these two are ours too.
for (const a of ['LastWorkspace', 'MoveToLastWorkspace']) {
    assert.ok(ours.has(a), `${a} has no KWin action to bind, so it is ours`);
}

const theirs = new Set(bindings.filter((e) => e.owner === KDE).map((e) => e.action));
for (const a of ['Close', 'Maximize', 'Fullscreen', 'MoveToOutput(Left)', 'SwitchOutput(Left)']) {
    assert.ok(theirs.has(a), `${a} is something KWin already does`);
}

// Switching to a workspace by number is KWin's: the target already exists, so nothing has to
// be created and there is nothing to intercept.
for (const a of ['Workspace(1)', 'Workspace(9)', 'MoveToWorkspace(1)']) {
    assert.ok(theirs.has(a), `${a} names an existing workspace, so KWin can answer it`);
}

// A chord left to KDE is only useful if something KDE has holds it. KDE ships these actions with
// no key, or with a different one -- Meta+1 is Plasma's task manager, Meta+Q its activity switcher --
// so each names the action install.sh has to give the chord to.
for (const e of bindings.filter((b) => b.owner === KDE)) {
    assert.ok(e.native && e.native.component && e.native.action,
        `${e.chord} (${e.action}) is left to KDE but names no native action`);
}

// The COSMIC System(...) actions KDE answers: each is one of two shapes, and none may take a
// chord this module registers.
{
    const system = keymap.system || [];
    assert.ok(system.length > 0, 'the system actions are missing');
    const ours = new Set(bindings.filter((b) => b.owner === KOSMIC).map((b) => b.chord));
    for (const e of system) {
        assert.ok(!!e.via !== !!e.command, `${e.chord}: needs exactly one of via and command`);
        assert.ok(!ours.has(e.chord), `${e.chord} is a System action and a KOSMIC binding`);
    }
}

// Nothing is claimed by both.
for (const a of ours) assert.ok(!theirs.has(a), `${a} is claimed by both sides`);

// ---------- the additions do not collide ----------

// A modal addition binds only while its mode is active, so it is allowed to share a chord with
// a non-modal binding. A non-modal one is not.
for (const e of additions) {
    if (e.modal) continue;
    assert.ok(!byChord.has(e.chord), `${e.chord} is in bindings already, so it is not an addition`);
}

{
    const extraChords = new Set(additions.filter((e) => !e.modal).map((e) => e.chord));
    for (const b of inScope) {
        assert.ok(!extraChords.has(b.chord),
            `${b.chord} is taken by COSMIC's ${b.action}, so it is not free`);
    }
}

// No two always-bound shortcuts may name one chord. kglobalshortcutsrc holds a line per name,
// and two lines claiming the same chord conflict — the second simply never arrives, with nothing
// logged anywhere. This is why a modal key is written with an empty chord in kglobalshortcutsrc
// and gets its sequence from the QML only while its mode is active.
{
    const always = bindings.filter((e) => e.name)
        .concat(additions.filter((e) => !e.modal));
    const seen = new Map();
    for (const e of always) {
        const prev = seen.get(e.chord);
        assert.ok(!prev, `${e.chord} is claimed by both ${prev && prev.name} and ${e.name}; `
            + 'two always-bound names on one chord conflict in kglobalshortcutsrc');
        seen.set(e.chord, e);
    }
}

// Nothing is modal. A `modal` entry was a second registration carrying a chord Focus already
// holds, bound only while its mode was active, and kglobalaccel does not work that way: this file
// is written into kglobalshortcutsrc as `none` for those names -- they must not hold the chord
// when the mode is off -- and the stored value wins over the QML default, so they were unbound in
// every mode and the mode did nothing at all. A mode now reinterprets the keys Focus already has.
for (const e of additions) {
    assert.ok(!e.modal, `${e.name} registers a chord that Focus already holds; `
        + 'kglobalaccel gives a chord to one name, and the mode has to reinterpret it instead');
}

// Every modal chord that shadows a plain binding must shadow one that is ours, not KDE's:
// shadowing a KWin shortcut would be this module taking a key System Settings owns.
for (const e of additions.filter((x) => x.modal)) {
    const shadowed = byChord.get(e.chord);
    if (!shadowed) continue;
    assert.strictEqual(shadowed.owner, KOSMIC,
        `${e.chord} shadows ${shadowed.action}, which is KWin's`);
}

// Meta+Period and Meta+Comma really are COSMIC's zoom keys. If that ever stops being true the
// justification written beside them is wrong and should be rewritten rather than left standing.
{
    const zoom = upstream.filter((b) => b.action === 'ZoomIn' || b.action === 'ZoomOut')
        .map((b) => b.chord);
    assert.ok(zoom.includes('Meta+Period'), 'the stated collision is real');
    assert.ok(zoom.includes('Meta+Comma'));
}

// ---------- nothing from the adjustment mode survived ----------
//
// Pop Shell's adjustment mode is gone: COSMIC has no such thing, and its resize mode replaces
// it. These names were registered until the keymap moved into this file, and a stale one left
// behind would keep a dead chord bound for a whole session.
{
    const names = new Set(bindings.filter((e) => e.name).map((e) => e.name)
        .concat(additions.map((e) => e.name)));
    // KosmicSwap* is deliberately not in this list. COSMIC's swap mode means the same thing the
    // adjustment mode's swap keys meant and binds them the same way, so the names are reused
    // rather than retired and minted again.
    for (const dead of ['KosmicEnter', 'KosmicAccept', 'KosmicReject', 'KosmicModeOrientation',
                        'KosmicMoveLeft', 'KosmicMoveRight', 'KosmicMoveUp', 'KosmicMoveDown']) {
        assert.ok(!names.has(dead), `${dead} is from the adjustment mode and should be gone`);
    }
}

// ---------- the chord spelling is KWin's ----------

for (const e of bindings.concat(additions)) {
    assert.ok(!/\bSuper\b/.test(e.chord), `${e.chord} uses Super; KWin writes Meta`);
    const parts = e.chord.split('+');
    const mods = parts.slice(0, -1);
    const ordered = mods.slice().sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
    assert.deepStrictEqual(mods, ordered, `${e.chord} has its modifiers out of KWin's order`);
}

console.log(`ALL OK (${inScope.length} upstream bindings in scope, `
    + `${bindings.length} in the file, ${additions.length} additions)`);
