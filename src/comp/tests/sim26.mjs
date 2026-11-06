// Checks keybindings.json against fixtures/keybindings.ron (COSMIC's file verbatim): every in-scope
// chord must be bound exactly once with the same action, or declined under `divergences`.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ron = fs.readFileSync(path.join(here, 'fixtures', 'keybindings.ron'), 'utf8');

// Passed in because the keymap sits at the repo root, which only a full checkout guarantees.
const keymapPath = process.argv[3]
    || path.resolve(path.dirname(process.argv[2]), '..', '..', '..', '..', '..', 'keybindings.json');
const keymap = JSON.parse(fs.readFileSync(keymapPath, 'utf8'));
const { bindings, additions } = keymap;
const divergences = keymap.divergences || [];

const KOSMIC = 'kosmic', KDE = 'kde';

// Matches `(modifiers: [Super, Shift], key: "h"): Move(Left),`; the key is optional.
const LINE = /^\s*\(modifiers:\s*\[([^\]]*)\](?:,\s*key:\s*"([^"]*)")?\):\s*(.+?),?\s*$/;

const MOD_NAME = { Super: 'Meta', Shift: 'Shift', Ctrl: 'Ctrl', Alt: 'Alt' };
// KWin writes modifiers in a fixed order, so normalise rather than trust the .ron order.
const MOD_ORDER = ['Meta', 'Ctrl', 'Shift', 'Alt'];

function chordOf(mods, key) {
    const names = mods
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
        .map((m) => MOD_NAME[m] || m);
    names.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));

    if (!key) return names.join('+');
    // xkb names to KWin spelling: single letters uppercase, all-lowercase names capitalised ("period" -> "Period").
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

const OUT_OF_SCOPE = (b) =>
    b.action.startsWith('System(') ||   // launcher, terminal, screenshot, volume: KDE's already
    b.action === 'Terminate' ||
    b.action === 'Debug' ||
    b.action === 'ZoomIn' ||
    b.action === 'ZoomOut';

const inScope = upstream.filter((b) => !OUT_OF_SCOPE(b));
assert.ok(inScope.length > 60, `only ${inScope.length} bindings in scope, expected far more`);

const dropped = upstream.filter(OUT_OF_SCOPE).map((b) => b.action);
assert.ok(dropped.includes('System(Launcher)'));
assert.ok(dropped.includes('ZoomIn'));
assert.ok(!dropped.some((a) => a.startsWith('Focus(')), 'focus is never out of scope');
assert.ok(!dropped.some((a) => a.startsWith('Move(')), 'neither is move');

const byChord = new Map();
for (const e of bindings) {
    assert.ok(!byChord.has(e.chord), `${e.chord} is claimed twice in keybindings.json`);
    byChord.set(e.chord, e);
}

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

    if (e.modal) {
        assert.ok(keymap.modes && keymap.modes[e.modal],
            `${e.chord} claims mode "${e.modal}", which is not documented under modes`);
    } else {
        assert.ok(e.why && e.why.length > 40,
            `${e.chord} is a standalone addition and needs its own justification`);
    }
}

// Modes reinterpret the keys Focus holds: kglobalshortcutsrc stores modal names as `none`,
// and that stored value beats the QML default, so a `modal` entry would never be bound.
for (const [name, mode] of Object.entries(keymap.modes || {})) {
    assert.ok(!additions.some((e) => e.modal === name),
        `mode "${name}" registers keys of its own; a chord already taken cannot be bound twice`);
    assert.ok(Array.isArray(mode.arm) && mode.arm.length > 0, `mode "${name}" is never armed`);
    for (const a of mode.arm) {
        assert.ok(bindings.some((b) => b.action === a),
            `mode "${name}" is armed by ${a}, which is not a binding`);
    }
    assert.ok(mode.why, `mode "${name}" has no reason written down`);

    // tools/gen.mjs writes these names into install.d/chordhold.ini and silenced.txt, so a wrong one breaks both silently.
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

// The plugin reads evdev scan codes and holds one modifier plus one key; tools/gen.mjs enforces the same.
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

// kglobalaccel silently leaves the second of two entries sharing a name unreachable.
{
    const names = bindings.filter((e) => e.name).map((e) => e.name)
        .concat(additions.map((e) => e.name));
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepStrictEqual(dup, [], 'a shortcut name is used twice');
}

const ours = new Set(bindings.filter((e) => e.owner === KOSMIC).map((e) => e.action));
for (const a of ['Focus(Left)', 'Focus(In)', 'Focus(Out)', 'Move(Left)', 'SwapWindow',
                 'ToggleOrientation', 'ToggleStacking', 'ToggleTiling', 'ToggleWindowFloating',
                 'Resizing(Outwards)']) {
    assert.ok(ours.has(a), `${a} needs the tree, so it has to be ours`);
}

for (const a of ['NextWorkspace', 'PreviousWorkspace',
                 'MoveToNextWorkspace', 'MoveToPreviousWorkspace']) {
    assert.ok(ours.has(a), `${a} has to create a workspace on demand, so it is ours`);
}

for (const a of ['LastWorkspace', 'MoveToLastWorkspace']) {
    assert.ok(ours.has(a), `${a} has no KWin action to bind, so it is ours`);
}

const theirs = new Set(bindings.filter((e) => e.owner === KDE).map((e) => e.action));
for (const a of ['Close', 'Maximize', 'Fullscreen', 'MoveToOutput(Left)', 'SwitchOutput(Left)']) {
    assert.ok(theirs.has(a), `${a} is something KWin already does`);
}

for (const a of ['Workspace(1)', 'Workspace(9)', 'MoveToWorkspace(1)']) {
    assert.ok(theirs.has(a), `${a} names an existing workspace, so KWin can answer it`);
}

// KDE ships these actions unbound or on other keys (Meta+1 is the task manager), so install.sh reassigns them.
for (const e of bindings.filter((b) => b.owner === KDE)) {
    assert.ok(e.native && e.native.component && e.native.action,
        `${e.chord} (${e.action}) is left to KDE but names no native action`);
}

{
    const system = keymap.system || [];
    assert.ok(system.length > 0, 'the system actions are missing');
    const ours = new Set(bindings.filter((b) => b.owner === KOSMIC).map((b) => b.chord));
    for (const e of system) {
        assert.ok(!!e.via !== !!e.command, `${e.chord}: needs exactly one of via and command`);
        assert.ok(!ours.has(e.chord), `${e.chord} is a System action and a KOSMIC binding`);
    }
}

for (const a of ours) assert.ok(!theirs.has(a), `${a} is claimed by both sides`);

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

// kglobalshortcutsrc gives a chord to one name; a second claimant silently never fires.
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

for (const e of additions) {
    assert.ok(!e.modal, `${e.name} registers a chord that Focus already holds; `
        + 'kglobalaccel gives a chord to one name, and the mode has to reinterpret it instead');
}

// Shadowing a KWin shortcut would take a key System Settings owns.
for (const e of additions.filter((x) => x.modal)) {
    const shadowed = byChord.get(e.chord);
    if (!shadowed) continue;
    assert.strictEqual(shadowed.owner, KOSMIC,
        `${e.chord} shadows ${shadowed.action}, which is KWin's`);
}

// The zoom-collision justification in keybindings.json depends on this; rewrite it if this fails.
{
    const zoom = upstream.filter((b) => b.action === 'ZoomIn' || b.action === 'ZoomOut')
        .map((b) => b.chord);
    assert.ok(zoom.includes('Meta+Period'), 'the stated collision is real');
    assert.ok(zoom.includes('Meta+Comma'));
}

// Pop Shell adjustment-mode names; a stale one would keep a dead chord bound for the session.
{
    const names = new Set(bindings.filter((e) => e.name).map((e) => e.name)
        .concat(additions.map((e) => e.name)));
    // KosmicSwap* is deliberately absent: COSMIC's swap mode reuses those names with the same meaning.
    for (const dead of ['KosmicEnter', 'KosmicAccept', 'KosmicReject', 'KosmicModeOrientation',
                        'KosmicMoveLeft', 'KosmicMoveRight', 'KosmicMoveUp', 'KosmicMoveDown']) {
        assert.ok(!names.has(dead), `${dead} is from the adjustment mode and should be gone`);
    }
}

for (const e of bindings.concat(additions)) {
    assert.ok(!/\bSuper\b/.test(e.chord), `${e.chord} uses Super; KWin writes Meta`);
    const parts = e.chord.split('+');
    const mods = parts.slice(0, -1);
    const ordered = mods.slice().sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
    assert.deepStrictEqual(mods, ordered, `${e.chord} has its modifiers out of KWin's order`);
}

console.log(`ALL OK (${inScope.length} upstream bindings in scope, `
    + `${bindings.length} in the file, ${additions.length} additions)`);
