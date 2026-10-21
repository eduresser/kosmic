#include "tiling.h"

#include <QDBusConnection>
#include <QDBusMessage>
#include <QStringList>
#include <QVariantMap>

#include <utility>

static const QString s_path = QStringLiteral("/Tiling");
static const QString s_iface = QStringLiteral("io.github.eduresser.kosmic.Tiling");

// The caller's own timeout must exceed this (busctl defaults to 25s), or the long poll turns back into a poll.
static const int s_windowMs = 600000;

Tiling::Tiling(int ttlMs, QObject *parent)
    : QObject(parent)
    , m_ttlMs(ttlMs)
{
    // Announced so PropertiesChanged subscribers do not keep holding a stale "on".
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
    // Margin: hasExpired is false at elapsed == timeout, so an exact-TTL timer announced the value it should retire.
    m_expiry.start(m_ttlMs + 50);
    if (state() != was) {
        announce();
    }
}

QString Tiling::WaitForChange()
{
    // The reply is built later in flushWaiting(); Qt still needs a QString back.
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
    // Taken first: send() can run code that re-arms into the list being iterated.
    const QList<QDBusMessage> waiting = std::move(m_waiting);
    m_waiting.clear();
    m_window.stop();
    for (const QDBusMessage &msg : waiting) {
        QDBusConnection::sessionBus().send(msg.createReply(now));
    }
}

void Tiling::announce()
{
    flushWaiting();

    // QtDBus does not emit PropertiesChanged for a Q_PROPERTY without NOTIFY.
    QDBusMessage signal = QDBusMessage::createSignal(s_path,
                                                     QStringLiteral("org.freedesktop.DBus.Properties"),
                                                     QStringLiteral("PropertiesChanged"));
    const QVariantMap changed{{QStringLiteral("State"), state()}};
    signal << s_iface << changed << QStringList();
    QDBusConnection::sessionBus().send(signal);
}
