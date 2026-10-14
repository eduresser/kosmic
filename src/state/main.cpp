#include "tiling.h"

#include <QCommandLineOption>
#include <QCommandLineParser>
#include <QCoreApplication>
#include <QDBusConnection>
#include <QDBusError>
#include <QDebug>

// How long a published value stays valid, in milliseconds. It has to be comfortably longer than
// the interval the applet refreshes at (2s, see src/applet/contents/ui/main.qml) or an open popup
// would watch the switch grey out between refreshes; and short enough that a tiler which has gone
// away stops being believed within a second or two of someone looking.
static const int s_defaultTtlMs = 5000;

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("kosmic-stated"));
    QCoreApplication::setApplicationVersion(QStringLiteral(KOSMIC_VERSION));

    QCommandLineParser parser;
    parser.setApplicationDescription(QStringLiteral("Holds KOSMIC's tiling state for the panel applet"));
    parser.addHelpOption();
    parser.addVersionOption();
    QCommandLineOption ttlOption(QStringLiteral("ttl"),
                                 QStringLiteral("Milliseconds a published value stays valid."),
                                 QStringLiteral("ms"), QString::number(s_defaultTtlMs));
    parser.addOption(ttlOption);
    parser.process(app);

    bool ok = false;
    const int ttl = parser.value(ttlOption).toInt(&ok);
    if (!ok || ttl <= 0) {
        qCritical("--ttl must be a positive number of milliseconds");
        return 1;
    }

    QDBusConnection bus = QDBusConnection::sessionBus();
    if (!bus.isConnected()) {
        qCritical("no session bus");
        return 1;
    }

    Tiling tiling(ttl);
    // The object first, then the name: a client that sees the name appear must find the object
    // already there, or its first read fails for no reason it can act on.
    if (!bus.registerObject(QStringLiteral("/Tiling"), &tiling,
                            QDBusConnection::ExportAllSlots | QDBusConnection::ExportAllProperties)) {
        qCritical("could not export /Tiling: %s", qPrintable(bus.lastError().message()));
        return 1;
    }
    if (!bus.registerService(QStringLiteral("io.github.eduresser.kosmic"))) {
        // Someone else already holds it, which for a service whose whole content is one value
        // means a second copy would answer half the reads with the wrong answer. Exit rather than
        // run alongside it.
        qCritical("io.github.eduresser.kosmic is already taken: %s", qPrintable(bus.lastError().message()));
        return 1;
    }

    return app.exec();
}
