/*
    KOSMIC: a mode chord as a held gesture.
*/

#pragma once

#include "kwin/input.h"
#include "kwin/plugin.h"

#include <QList>
#include <QString>

namespace KWin
{

/**
 * Turns KOSMIC's mode chords into what they are upstream: holds.
 *
 * cosmic-comp ends a mode the moment a modifier of the binding goes up, and performs
 * whatever the mode owed on that same release (input/mod.rs:2407-2426 for the swap). A KWin
 * *script* is delivered a shortcut activation and never a release -- registerShortcut is the whole
 * of its key input -- so a mode there has to be a toggle, and leaving it needs a second press.
 * This plugin is the missing half: it sees the releases and calls the tiler's own shortcuts, so
 * the tiler keeps deciding *what* a mode does and this only says *when* it is on.
 *
 * A toggle with no modifier over it is not merely less faithful, it is a trap: a mode left armed
 * outlives the work that armed it, so the next Meta+R disarms when its user means to arm, and the
 * arrows move the focus instead of resizing. A state nobody can see, flipped by the only key that
 * reports it, is indistinguishable from a broken key. Here the mode lives only under a held
 * modifier, so letting the modifier go always ends it and no state outlives a gesture.
 *
 * Two things were measured before this was written:
 *
 *  - The releases are all there. Read off /dev/input, a whole gesture is LEFTMETA down, X down,
 *    arrow down, arrow up, X up, LEFTMETA up. A key *state* is all this has to keep.
 *
 *  - A repeat stream cannot stand in for that state. Both the kernel and KWin repeat exactly one
 *    key, the last one pressed (keyboard_repeat.cpp:51), so pressing an arrow moves the repeat off
 *    X and releasing the arrow stops it without it ever returning -- measured as six seconds of
 *    silence with X still physically down.
 *
 * Several chords, because there are several modes and they are independent: one may be held while
 * another is not, and a modifier they share has to end both. They are configured from
 * keybindings.json, the one place a KOSMIC chord is spelled.
 *
 * The *letter* may be let go without ending the mode, which upstream does not allow; see
 * keyboardKey. Keyboards without full n-key rollover drop whichever of Meta, letter and arrow
 * closes that trio last, before any program sees it, and the gesture needs only two keys at a time
 * if the letter is allowed to come up. Holding it still works either way.
 */
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
        // The modifier is read out of xkb's state rather than matched against a scan code, so
        // whichever key the layout makes it answers, on any layout. Matching a position would have
        // watched one key and ignored every other the layout gives the same meaning.
        Qt::KeyboardModifiers modifier = Qt::NoModifier;
        // The key stays an evdev scan code, written into kwinrc from install.d/chordhold.ini: a
        // KWin plugin reads the keyboard below any layout, and the codes in
        // linux/input-event-codes.h name *positions*.
        quint32 key = 0;
        QString arm;
        QString commit;

        bool modifierDown = false;
        bool armed = false;
        // Whether the key press currently in flight was swallowed, so its release is swallowed
        // too. Leaving a release through after blocking the press is how an application ends up
        // believing the key is still down.
        bool swallowing = false;
    };

    void invoke(const QString &name) const;

    QString m_component;
    QList<Chord> m_chords;
};

} // namespace KWin
