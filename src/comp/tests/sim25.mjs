// Tiling exceptions: is_dialog :20 and has_floating_exception :93, with the default rule set
// from data/tiling-exceptions.ron.
//
// The detail that decides most of these cases: the appid and title patterns of *one rule* must
// both match. Upstream runs two RegexSets and then requires the same index to have matched in
// both, so it is an AND within a rule and an OR across rules. Reading it as "any appid matches
// and any title matches" floats far too much — Steam's login window rule would float every
// Steam window, and the ".*" appid rule for "Discord Updater" would float everything.
//
// Also pinned down:
//   - a rule whose regexes do not compile is dropped whole, not treated as matching nothing
//   - `titles: [...]` expands to one rule per title, the way the config layer does it
//   - an empty pattern matches everything, which is how a rule names an application regardless
//     of title, and is also why the default set's empty-appid rule is title-only
//   - a fixed-size window is a dialog whatever it calls itself
//
import assert from 'node:assert';
import path from 'node:path';

const tiler = process.argv[2];
const core = await import(path.join(path.dirname(tiler), 'core.mjs'));
const { isDialog, compileExceptions, hasFloatingException, DEFAULT_EXCEPTIONS } = core;

// ---------- is_dialog ----------

assert.strictEqual(isDialog(null), false);
assert.strictEqual(isDialog({}), false, 'a plain window is not a dialog');
assert.strictEqual(isDialog({ transient: true }), true, 'having a parent makes it one');
assert.strictEqual(isDialog({ modal: true }), true);
assert.strictEqual(isDialog({ dialog: true }), true);
assert.strictEqual(isDialog({ override: true }), true, 'override-redirect counts');

// A fixed size gives a window away whatever it calls itself: it cannot be tiled into an
// arbitrary slot if its minimum and maximum agree.
assert.strictEqual(
    isDialog({ minSize: { w: 400, h: 300 }, maxSize: { w: 400, h: 300 } }), true,
    'min == max is a fixed-size window');
assert.strictEqual(
    isDialog({ minSize: { w: 400, h: 300 }, maxSize: { w: 800, h: 600 } }), false,
    'a window that can grow is not');
assert.strictEqual(
    isDialog({ minSize: { w: 0, h: 0 }, maxSize: { w: 0, h: 0 } }), false,
    'both unset is not a fixed size, it is no constraint at all');
assert.strictEqual(isDialog({ minSize: { w: 400, h: 300 } }), false, 'a minimum alone says nothing');
assert.strictEqual(isDialog({ maxSize: { w: 400, h: 300 } }), false);

// ---------- the AND within a rule ----------

{
    const ex = compileExceptions([
        { appid: 'Steam', title: '^.*?(Guard|Login).*' },
        { appid: 'Enpass', title: 'Enpass Assistant' },
    ]);

    assert.ok(hasFloatingException(ex, 'Steam', 'Steam Guard'), 'both halves of one rule match');
    assert.ok(!hasFloatingException(ex, 'Steam', 'Library'),
        'the right app with the wrong title does not float');
    assert.ok(!hasFloatingException(ex, 'Enpass', 'Steam Guard'),
        'the appid of one rule and the title of another is not a match');
    assert.ok(hasFloatingException(ex, 'Enpass', 'Enpass Assistant'));
    assert.ok(!hasFloatingException(ex, 'Firefox', 'Anything'));
}

// ---------- an empty pattern matches everything ----------

{
    const ex = compileExceptions([{ appid: 'Guake', title: '.*' }]);
    assert.ok(hasFloatingException(ex, 'Guake', 'whatever'));
    assert.ok(hasFloatingException(ex, 'Guake', ''));
}
{
    // The default set's title-only rule: an empty appid matches any application.
    const ex = compileExceptions([{ appid: '', titles: ['Steam'] }]);
    assert.ok(hasFloatingException(ex, 'anything-at-all', 'Steam'));
    assert.ok(!hasFloatingException(ex, 'anything-at-all', 'Other'));
}

// ---------- titles expands to one rule per title ----------

{
    const ex = compileExceptions([
        { appid: 'jetbrains-webstorm', titles: ['Customize WebStorm', 'License Activation'] },
    ]);
    assert.strictEqual(ex.length, 2, 'two titles, two rules');
    assert.ok(hasFloatingException(ex, 'jetbrains-webstorm', 'Customize WebStorm'));
    assert.ok(hasFloatingException(ex, 'jetbrains-webstorm', 'License Activation'));
    assert.ok(!hasFloatingException(ex, 'jetbrains-webstorm', 'Project'));
}

// ---------- a bad regex drops its rule rather than matching nothing quietly ----------

{
    const bad = [];
    const ex = compileExceptions([
        { appid: '[unclosed', title: '.*' },
        { appid: 'Good', title: '.*' },
    ], (rule, err) => bad.push({ rule, err }));

    assert.strictEqual(ex.length, 1, 'only the sound rule survives');
    assert.strictEqual(bad.length, 1, 'and the broken one is reported');
    assert.strictEqual(bad[0].rule.appid, '[unclosed');
    assert.ok(bad[0].err.length > 0, 'with the reason, so it can be logged');
    assert.ok(hasFloatingException(ex, 'Good', 'x'));
}

{
    // A broken title drops the rule too, not just the title.
    const bad = [];
    const ex = compileExceptions([{ appid: 'App', title: '(' }], (r, e) => bad.push(e));
    assert.strictEqual(ex.length, 0);
    assert.strictEqual(bad.length, 1);
}

// ---------- missing input is not a match ----------

{
    const ex = compileExceptions([{ appid: 'Steam', title: 'Login' }]);
    assert.ok(!hasFloatingException(ex, null, null));
    assert.ok(!hasFloatingException(ex, undefined, undefined));
    assert.ok(!hasFloatingException([], 'Steam', 'Login'), 'no rules, no exceptions');
    assert.ok(!hasFloatingException(null, 'Steam', 'Login'));
}

// ---------- the default set behaves as COSMIC's does ----------

{
    const ex = compileExceptions(DEFAULT_EXCEPTIONS);

    // Things COSMIC floats.
    assert.ok(hasFloatingException(ex, 'Guake', 'Guake'), 'a drop-down terminal floats');
    assert.ok(hasFloatingException(ex, 'krunner', 'KRunner'));
    assert.ok(hasFloatingException(ex, 'Steam', 'Steam Guard - Login'));
    assert.ok(hasFloatingException(ex, 'TelegramDesktop', 'Media viewer'));
    assert.ok(hasFloatingException(ex, 'ibus-ui-gtk3', 'anything'), 'ibus-.* is a prefix rule');
    assert.ok(hasFloatingException(ex, 'com.slack.Slack', 'Slack | Huddle Preview'));
    assert.ok(hasFloatingException(ex, 'thunderbird', 'Write: a new message'));
    assert.ok(hasFloatingException(ex, 'org.mozilla.thunderbird-esr', 'Write: a new message'));
    assert.ok(hasFloatingException(ex, 'anything', 'Discord Updater'),
        'the .* appid rule is title-only in practice');

    // A window *titled* Steam floats whatever application it belongs to: the default set has an
    // empty-appid rule for it, which the .ron marks "Empty appid title only matches". That is
    // broader than it looks and catches Steam's own library window, not just its splash. It is
    // COSMIC's behaviour and is recorded here rather than quietly narrowed.
    assert.ok(hasFloatingException(ex, 'Steam', 'Steam'));
    assert.ok(hasFloatingException(ex, 'something-else', 'Steam'));
    assert.ok(!hasFloatingException(ex, 'Steam', 'Half-Life'),
        'but a Steam window with another title tiles');

    // Things it does not float. These are the cases the AND protects.
    assert.ok(!hasFloatingException(ex, 'TelegramDesktop', 'Telegram'), 'the chat window tiles');
    assert.ok(!hasFloatingException(ex, 'thunderbird', 'Inbox'), 'the mail window tiles');
    assert.ok(!hasFloatingException(ex, 'com.slack.Slack', 'Slack | general'));
    assert.ok(!hasFloatingException(ex, 'firefox', 'Mozilla Firefox'));
    assert.ok(!hasFloatingException(ex, 'Alacritty', 'Alacritty'));
    assert.ok(!hasFloatingException(ex, 'code', 'core.mjs - kosmic'));
    assert.ok(!hasFloatingException(ex, 'vivaldi-stable', 'Google'));
}

// The KDE additions, which COSMIC has no reason to list.
{
    const ex = compileExceptions(DEFAULT_EXCEPTIONS);
    for (const id of [
        'plasmashell', 'org.kde.plasmashell', 'ksplashqml', 'kded5', 'kded6',
        'xwaylandvideobridge', 'polkit-kde-authentication-agent-1',
        'org.kde.polkit-kde-authentication-agent-1', 'kruler', 'org.kde.kruler',
        'kwin_wayland', 'ksmserver-logout-greeter', 'yakuake', 'org.kde.yakuake', 'conky',
        // The KDE counterpart of gnome-screenshot, which COSMIC lists. Its window exists
        // while a capture is being taken and is not on the screen, so a tile reserved for
        // it is a slot nothing is drawn into -- and one no check in the adapter can see,
        // because the window is real, mapped, on this workspace and in exactly one leaf.
        'spectacle', 'org.kde.spectacle',
    ]) {
        assert.ok(hasFloatingException(ex, id, 'any title'), `${id} stays out of the tree`);
    }

    // The anchors matter: these rules must not catch an application that merely starts the same
    // way. A pattern of "kded" without anchors would float anything containing it.
    assert.ok(!hasFloatingException(ex, 'kdeconnect-indicator', 'KDE Connect'),
        'an anchored rule does not swallow a neighbour');
    assert.ok(!hasFloatingException(ex, 'my-plasmashell-helper', 'x'));
    assert.ok(!hasFloatingException(ex, 'kruler-clone', 'x'));
    assert.ok(!hasFloatingException(ex, 'spectacle-viewer', 'x'));
}

// Every default rule compiles. A silent drop here would float nothing and look like the
// exception list doing nothing at all.
{
    const bad = [];
    const ex = compileExceptions(DEFAULT_EXCEPTIONS, (r, e) => bad.push({ r, e }));
    assert.deepStrictEqual(bad, [], 'no default rule has a broken pattern');
    const expanded = DEFAULT_EXCEPTIONS.reduce((n, r) => n + r.titles.length, 0);
    assert.strictEqual(ex.length, expanded, 'and every title became a rule');
}

console.log('ALL OK');
