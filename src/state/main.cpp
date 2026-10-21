#include "tiling.h"

#include <QCommandLineOption>
#include <QCommandLineParser>
#include <QCoreApplication>
#include <QDBusConnection>
#include <QDBusError>
#include <QDebug>

// Must exceed the applet's refresh interval (2s), or the popup switch greys out between refreshes.
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
    // Object before name: a client that sees the name must find the object.
    if (!bus.registerObject(QStringLiteral("/Tiling"), &tiling,
                            QDBusConnection::ExportAllSlots | QDBusConnection::ExportAllProperties)) {
        qCritical("could not export /Tiling: %s", qPrintable(bus.lastError().message()));
        return 1;
    }
    if (!bus.registerService(QStringLiteral("io.github.eduresser.kosmic"))) {
        // A second copy would answer reads wrongly; exit instead.
        qCritical("io.github.eduresser.kosmic is already taken: %s", qPrintable(bus.lastError().message()));
        return 1;
    }

    return app.exec();
}
