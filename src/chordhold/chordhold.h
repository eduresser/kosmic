#pragma once

#include "kwin/input.h"
#include "kwin/plugin.h"

#include <QList>
#include <QString>

namespace KWin
{

/* cosmic-comp ends a mode on modifier release; a KWin script never receives releases, so this plugin supplies them. */
class ChordHold : public Plugin, public InputEventFilter
{
    Q_OBJECT

public:
    ChordHold();
    ~ChordHold() override;

    bool keyboardKey(KeyboardKeyEvent *event) override;

private:
    struct Chord
    {
        Qt::KeyboardModifiers modifier = Qt::NoModifier;
        // evdev scan code, not a keysym: a KWin plugin reads below the layout.
        quint32 key = 0;
        QString arm;
        QString commit;

        bool modifierDown = false;
        bool armed = false;
        // Release must be swallowed if its press was, or the app believes the key is still down.
        bool swallowing = false;
    };

    void invoke(const QString &name) const;

    QString m_component;
    QList<Chord> m_chords;
};

} // namespace KWin
