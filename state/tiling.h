// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// The one value KOSMIC cannot keep anywhere else.
//
// Which workspace tiles is decided in core.mjs and lives inside the KWin script, and a KWin script
// has no way to let anything read it: callDBus only goes out, there is no writeConfig, and the
// scripting API registers no service. Without somewhere to read it, the applet can only show a
// button where cosmic-applet-tiling shows a toggler -- a switch with nothing to read is a guess
// that goes wrong at the first Meta+Y.
//
// This is the smallest thing that closes that gap: a session service holding one value, which the
// script pushes to and the applet reads from. It links QtCore and QtDBus and nothing else -- no
// KWin, no KF6 -- because the alternative was a KWin plugin, and KWin's plugin API provides no
// binary compatibility (effect/effect.h:967). Nothing here can be broken by a Plasma update.
//
// The value expires. A reader needs to tell "tiling is off" from "nobody has told me", and those
// are not the same answer: the script may not be loaded, or may not yet have registered the
// shortcut this is asked through. Holding the last value forever would turn a dead script into a
// confident wrong reading, so what is held is a *fresh* reading or nothing at all.
#pragma once

#include <QDBusContext>
#include <QDBusMessage>
#include <QElapsedTimer>
#include <QList>
#include <QObject>
#include <QString>
#include <QTimer>

class Tiling : public QObject, protected QDBusContext
{
    Q_OBJECT
    Q_CLASSINFO("D-Bus Interface", "io.github.eduresser.kosmic.Tiling")

    // "on", "off" or "unknown". Three values rather than a bool, for the reason above: the third
    // one is what a reader shows instead of a guess.
    Q_PROPERTY(QString State READ state)

public:
    explicit Tiling(int ttlMs, QObject *parent = nullptr);

    QString state() const;

public Q_SLOTS:
    // Called by the tiler, which is the only writer. Takes a bool because that is what the script
    // has; the third state is this object's, not the script's -- the script cannot report that it
    // is not running.
    void SetTiling(bool on);

    /**
     * Blocks until the state changes, then answers with the new one. A long poll, and it exists
     * because the panel applet has to show the state on its icon with its popup shut and QML has
     * no D-Bus binding to subscribe with: everything it does goes through `busctl` in a
     * subprocess, so "wait for a change" has to be something a subprocess can do by blocking.
     *
     * The obvious alternative was measured and rejected. `busctl --user monitor | grep -m1` does
     * block, but it does not *return* on the match: grep leaves and busctl only notices when it
     * next writes, which is the next signal -- a change took 5.9 seconds to come out, the TTL
     * expiry behind it flushing the pipe. A reply this object sends is a reply, and the caller
     * exits on it.
     *
     * Answers after a window even when nothing has changed, so the caller re-arms on a schedule
     * instead of holding a reply forever and so this list cannot grow. The caller's own timeout
     * has to be longer than that window; the applet passes one.
     */
    QString WaitForChange();

private:
    void announce();
    void flushWaiting();

    int m_ttlMs;
    bool m_on = false;
    QElapsedTimer m_since;   // invalid until the first SetTiling
    QTimer m_expiry;

    // Calls that have been told to wait. Held as messages rather than as a count because each one
    // has to be replied to individually -- `createReply` carries the serial the caller is
    // blocking on.
    QList<QDBusMessage> m_waiting;
    QTimer m_window;
};
