// A KWin script cannot expose its tiling state (callDBus only goes out), so this holds it for the applet.
// It expires, so a dead script reads as unknown instead of a stale value.
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

    // "on", "off" or "unknown": a missing or stale reading must not look like off.
    Q_PROPERTY(QString State READ state)

public:
    explicit Tiling(int ttlMs, QObject *parent = nullptr);

    QString state() const;

public Q_SLOTS:
    // The third state is this object's: the script cannot report that it is not running.
    void SetTiling(bool on);

    // Long poll: the applet's QML can only run busctl subprocesses, and `busctl monitor | grep -m1` does not
    // return on a match. Answers after a window even without a change; the caller's timeout must exceed it.
    QString WaitForChange();

private:
    void announce();
    void flushWaiting();

    int m_ttlMs;
    bool m_on = false;
    QElapsedTimer m_since;   // invalid until the first SetTiling
    QTimer m_expiry;

    // Messages, not a count: each needs its own createReply.
    QList<QDBusMessage> m_waiting;
    QTimer m_window;
};
