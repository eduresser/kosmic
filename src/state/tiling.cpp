#include "tiling.h"

#include <QDBusConnection>
#include <QDBusMessage>
#include <QStringList>
#include <QVariantMap>

#include <utility>

static const QString s_path = QStringLiteral("/Tiling");
static const QString s_iface = QStringLiteral("io.github.eduresser.kosmic.Tiling");

// How long WaitForChange holds a caller before answering anyway. Ten minutes is not a poll
// interval in disguise -- it is the longest this object is willing to owe somebody an answer, and
// the caller re-arming 144 times a day costs less than one `busctl` every few seconds would cost
// in an hour. A caller must pass a longer timeout of its own than this; `busctl` defaults to 25
// seconds, which would expire first and turn the long poll back into a poll.
static const int s_windowMs = 600000;

Tiling::Tiling(int ttlMs, QObject *parent)
    : QObject(parent)
    , m_ttlMs(ttlMs)
{
    // The expiry is announced rather than merely happening. A value that goes stale silently makes
    // PropertiesChanged a lie for anyone subscribed to it -- they would hold "on" long after this
    // object had started answering "unknown" to everybody who asked directly.
    m_expiry.setSingleShot(true);
    connect(&m_expiry, &QTimer::timeout, this, &Tiling::announce);

    m_window.setSingleShot(true);
    connect(&m_window, &QTimer::timeout, this, &Tiling::flushWaiting);
}

QString Tiling::state() const
{
    if (!m_since.isValid() || m_since.hasExpired(m_ttlMs)) {
        return QStringLiteral("unknown");
    }
    return m_on ? QStringLiteral("on") : QStringLiteral("off");
}

void Tiling::SetTiling(bool on)
{
    const QString was = state();
    m_on = on;
    m_since.start();
    // Plus a margin, and the margin is a measured one. QElapsedTimer::hasExpired is false while
    // elapsed == timeout, so an expiry timer armed for exactly the TTL fires in the last instant
    // the value is still valid and announces the value it was supposed to be retiring -- seen on
    // the bus: the expiry signal carried "on". The margin can only make it late, never early.
    m_expiry.start(m_ttlMs + 50);
    if (state() != was) {
        announce();
    }
}

QString Tiling::WaitForChange()
{
    // The return value is not what the caller gets -- flushWaiting() builds the reply later. Qt
    // still needs a QString back because the signature is part of the interface.
    setDelayedReply(true);
    m_waiting.append(message());
    if (!m_window.isActive()) {
        m_window.start(s_windowMs);
    }
    return QString();
}

void Tiling::flushWaiting()
{
    if (m_waiting.isEmpty()) {
        return;
    }
    const QString now = state();
    // Taken first, because send() can run anything waiting on this bus and a caller that re-arms
    // from inside its own reply would otherwise be appended to a list being iterated.
    const QList<QDBusMessage> waiting = std::move(m_waiting);
    m_waiting.clear();
    m_window.stop();
    for (const QDBusMessage &msg : waiting) {
        QDBusConnection::sessionBus().send(msg.createReply(now));
    }
}

void Tiling::announce()
{
    // Before the signal, so a caller that re-arms immediately is waiting again by the time
    // anything else on this bus has been given a turn.
    flushWaiting();

    // Written by hand because QtDBus does not emit PropertiesChanged for a Q_PROPERTY on its own,
    // and the property is computed anyway -- there is no NOTIFY signal to hang it on.
    QDBusMessage signal = QDBusMessage::createSignal(s_path,
                                                     QStringLiteral("org.freedesktop.DBus.Properties"),
                                                     QStringLiteral("PropertiesChanged"));
    const QVariantMap changed{{QStringLiteral("State"), state()}};
    signal << s_iface << changed << QStringList();
    QDBusConnection::sessionBus().send(signal);
}
