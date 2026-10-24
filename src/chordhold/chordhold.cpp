#include "chordhold.h"

#include "kwin/input_event.h"
#include "kwin/keyboard_input.h"
#include "kwin/wayland_server.h"
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

        if (chord.modifier == Qt::NoModifier || !chord.key || chord.arm.isEmpty() || chord.commit.isEmpty()) {
            qWarning("kosmic-chordhold: chord %d is incomplete, skipping", i);
            continue;
        }
        m_chords.append(chord);
    }

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
    // A repeat counts as a press: KeyboardTriggerHandler ends a gesture on any release.
    const bool pressed = event->state != KeyboardKeyState::Released;
    // Repeats keep state but never act: ~34/s once held, which flickered arm/commit.
    const bool firstPress = event->state == KeyboardKeyState::Pressed;
    const quint32 code = event->nativeScanCode;
    bool swallow = false;

    // A window that grabbed the keyboard (a VM viewer, a remote desktop) asked that no desktop shortcut act on its keys. KWin's own
    // shortcuts honour that; this filter runs before them, so without the check it would swallow the chord and act on the host.
    if (waylandServer() && waylandServer()->isKeyboardShortcutsInhibited()) {
        for (Chord &chord : m_chords) {
            if (chord.armed) {
                chord.armed = false;
                invoke(chord.commit);
            }
            chord.swallowing = false;
        }
        return false;
    }

    // KWin updates the xkb state before filters run, so the release that ends a mode already lacks the modifier.
    const Qt::KeyboardModifiers mods = input()->keyboard()->xkb()->modifiers();

    // The modifier is never swallowed: other desktop chords start with it.
    for (Chord &chord : m_chords) {
        chord.modifierDown = (mods & chord.modifier) == chord.modifier;
        if (chord.armed && !chord.modifierDown) {
            chord.armed = false;
            invoke(chord.commit);
        }
    }

    for (Chord &chord : m_chords) {
        if (chord.key != code) {
            continue;
        }

        if (pressed) {
            if (!chord.modifierDown) {
                chord.swallowing = false;
                continue;
            }
            if (firstPress) {
                // Deliberate divergence from upstream (input/mod.rs:2407): the letter may come up
                // without ending the mode, because keyboard matrices drop the last key of a Meta+letter+arrow triple.
                chord.armed = !chord.armed;
                invoke(chord.armed ? chord.arm : chord.commit);
            }
            // Swallowed after GlobalShortcut on purpose: earlier, the modifier-only launcher shortcut still fires on release.
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
