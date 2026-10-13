/*
    KOSMIC: a mode chord as a held gesture.
    SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>

    SPDX-License-Identifier: GPL-3.0-only
*/

#include "chordhold.h"

#include "kwin/input_event.h"
#include "kwin/keyboard_input.h"
#include "kwin/xkb.h"

#include <KConfigGroup>
#include <KSharedConfig>
#include <QDBusConnection>
#include <QDBusMessage>
#include <QDBusPendingCall>
#include <QDebug>

namespace KWin
{

namespace
{
// The NixOS module writes the modifier by name rather than by code, because a name is what xkb
// answers about and a code is what this deliberately stopped asking for.
Qt::KeyboardModifiers modifierFromName(const QString &name)
{
    if (name == QLatin1String("Meta")) {
        return Qt::MetaModifier;
    }
    if (name == QLatin1String("Ctrl")) {
        return Qt::ControlModifier;
    }
    if (name == QLatin1String("Alt")) {
        return Qt::AltModifier;
    }
    if (name == QLatin1String("Shift")) {
        return Qt::ShiftModifier;
    }
    return Qt::NoModifier;
}
} // namespace

ChordHold::ChordHold()
    : InputEventFilter(InputFilterOrder::Effects)
{
    const KConfigGroup config = KSharedConfig::openConfig(QStringLiteral("kwinrc"))
                                    ->group(QStringLiteral("Plugin-kosmic-chordhold"));
    m_component = config.readEntry("Component", QStringLiteral("kwin"));

    const int count = config.readEntry("Count", 0);
    for (int i = 0; i < count; ++i) {
        Chord chord;
        chord.modifier = modifierFromName(config.readEntry(QStringLiteral("Modifier%1").arg(i), QString()));
        chord.key = config.readEntry(QStringLiteral("Key%1").arg(i), 0);
        chord.arm = config.readEntry(QStringLiteral("Arm%1").arg(i), QString());
        chord.commit = config.readEntry(QStringLiteral("Commit%1").arg(i), QString());

        // A chord missing any part watches nothing, which on a keyboard is indistinguishable from
        // a chord that is never pressed. Saying so beats finding out from a gesture that never arms.
        if (chord.modifier == Qt::NoModifier || !chord.key || chord.arm.isEmpty() || chord.commit.isEmpty()) {
            qWarning("kosmic-chordhold: chord %d is incomplete, skipping", i);
            continue;
        }
        m_chords.append(chord);
    }

    // One line per session, always, and one per chord. A plugin that says nothing is
    // indistinguishable from a plugin that did not load, and this module has already paid an hour
    // for exactly that confusion.
    qInfo("kosmic-chordhold: loaded, %lld chord(s)", static_cast<long long>(m_chords.count()));
    for (const Chord &chord : std::as_const(m_chords)) {
        qInfo("kosmic-chordhold:   modifier=0x%x key=%u arm=%s commit=%s",
              static_cast<unsigned>(chord.modifier.toInt()), chord.key,
              qPrintable(chord.arm), qPrintable(chord.commit));
    }

    if (!m_chords.isEmpty()) {
        input()->installInputEventFilter(this);
    } else {
        qWarning("kosmic-chordhold: no usable chord, doing nothing");
    }
}

ChordHold::~ChordHold()
{
    if (auto *i = input()) {
        i->uninstallInputEventFilter(this);
    }
}

void ChordHold::invoke(const QString &name) const
{
    // Through kglobalaccel by name, which is the same door the tiler's own chords come in by, so
    // the tiler needs no new interface and this plugin needs no idea what a mode is. Measured
    // working before any of this was written: invoking KosmicSwapWindow by name put the mode OSD
    // on the screen.
    QDBusMessage message = QDBusMessage::createMethodCall(
        QStringLiteral("org.kde.kglobalaccel"),
        QStringLiteral("/component/") + m_component,
        QStringLiteral("org.kde.kglobalaccel.Component"),
        QStringLiteral("invokeShortcut"));
    message << name;
    QDBusConnection::sessionBus().asyncCall(message);
}

bool ChordHold::keyboardKey(KeyboardKeyEvent *event)
{
    // Repeated is a *press* that happens to be synthetic. Reading it as anything else is the bug
    // that cost this module most of a day in someone else's plugin: KeyboardTriggerHandler ends
    // every gesture on any release, so a held chord killed itself one RepeatDelay after it began.
    const bool pressed = event->state != KeyboardKeyState::Released;
    // A repeat keeps state and never acts. The letter acts on its press, and the kernel sends 34
    // of those a second once a key has been down half a second -- measured rather than assumed:
    // a letter held 2.9s produced 131 repeats, 33.6Hz. Acting on them is precisely the
    // frantic arm/commit flicker this module shipped as a toggle and was reported as a bug.
    const bool firstPress = event->state == KeyboardKeyState::Pressed;
    const quint32 code = event->nativeScanCode;
    bool swallow = false;

    // The modifier is asked of xkb instead of being matched against a scan code, so whichever key
    // the layout makes a Super answers, on any layout. KWin updates the xkb state before it runs
    // any filter, so by the time the release that ends a mode arrives here, the modifier is
    // already gone from this.
    const Qt::KeyboardModifiers mods = input()->keyboard()->xkb()->modifiers();

    // Every chord is asked, because they share a modifier: Meta carries both the swap and the
    // resize here, and letting it go has to end whichever of them is running. Nothing is swallowed
    // on account of the modifier: it belongs to everything else on the desktop as much as to these
    // gestures, and taking it would break every other chord that starts with it.
    for (Chord &chord : m_chords) {
        chord.modifierDown = (mods & chord.modifier) == chord.modifier;
        if (chord.armed && !chord.modifierDown) {
            chord.armed = false;
            invoke(chord.commit);
        }
    }

    // Then the keys. Still a loop rather than a lookup: two chords are allowed to share a key and
    // differ in their modifier, and the one whose modifier is down is the one that answers.
    for (Chord &chord : m_chords) {
        if (chord.key != code) {
            continue;
        }

        if (pressed) {
            if (!chord.modifierDown) {
                // The key on its own is the letter, and the letter is the application's.
                chord.swallowing = false;
                continue;
            }
            if (firstPress) {
                // The letter arms and, pressed again under the same held modifier, finishes. The
                // whole gesture happens with the modifier down -- press Meta, press the letter,
                // let the letter up, work with the arrows, press the letter again to finish -- and
                // the letter is free to come up in between because a mode does not end with it.
                //
                // That is a deliberate divergence from upstream: cosmic-comp ends a mode when a
                // modifier of the binding **or** its key goes up (input/mod.rs:2407). Holding both
                // and pressing an arrow is three keys at once, and a membrane matrix does not
                // report every triple. Read off the evdev stream, whichever of
                // Meta, R and Left closes that trio last is simply discarded -- Meta+R then Left
                // gives no Left, Meta+Left then R gives no R, R+Left then Meta gives no Meta --
                // while replacing any single member makes it whole: Meta+A+Left, Meta+Z+Left,
                // Ctrl/Alt/Shift+R+Left and R+Left+X all arrive. Anti-ghosting in the scan matrix,
                // and nothing above the controller can undo it. The code here was measured not to
                // be the problem: the same triple injected through uinput, where there is no
                // matrix, fires KosmicResizeArm, KosmicFocusLeft and KosmicResizeRelease in order.
                //
                // Letting the letter up takes the gesture back to two keys at a time, and two keys
                // is a thing every matrix reports. Holding the letter still works where the matrix
                // allows it -- the hjkl half here, and all four arrows on a keyboard with the
                // rollover for them -- because holding is one press and this acts on presses.
                //
                // A toggle that can only be flipped under a held modifier is not the trap a plain
                // toggle is: there, a mode left armed survives whatever follows and silently
                // changes what the arrows do. Here the modifier coming up always ends the mode,
                // so no state outlives the gesture.
                chord.armed = !chord.armed;
                invoke(chord.armed ? chord.arm : chord.commit);
            }
            // Swallowed from here down, which is what keeps the chord from being typed into
            // whatever is focused. This filter sits *after* InputFilterOrder::GlobalShortcut on
            // purpose: by then kglobalaccel has already seen the key and cancelled any
            // modifier-only shortcut waiting on it, so holding the chord no longer reads as "the
            // modifier was pressed alone" and does not open the launcher on release. Swallowing
            // earlier is what made it.
            chord.swallowing = true;
            swallow = true;
            continue;
        }

        if (chord.swallowing) {
            swallow = true;
        }
        chord.swallowing = false;
    }

    return swallow;
}

} // namespace KWin

#include "moc_chordhold.cpp"
