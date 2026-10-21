#include "outline.h"

#include "kwin/scene/outlinedborderitem.h"
#include "kwin/scene/windowitem.h"
#include "kwin/window.h"
#include "kwin/workspace.h"

#include <KConfig>
#include <KConfigGroup>
#include <KConfigWatcher>
#include <KSharedConfig>
#include <QDBusConnection>
#include <QDebug>
#include <QStringList>

namespace KWin
{

// Same address as contents/ui/main.qml.
static const QLatin1String s_dbusPath("/kosmic/Selection");

// Parsed by hand to avoid linking KF6::ConfigGui, whose QColor conversion is installed by a static initializer.
static QColor parseColor(const QString &text)
{
    const QString value = text.trimmed();
    if (value.isEmpty()) {
        return QColor();
    }
    if (value.startsWith(QLatin1Char('#'))) {
        return QColor::fromString(value);
    }
    const QStringList parts = value.split(QLatin1Char(','), Qt::SkipEmptyParts);
    if (parts.size() != 3 && parts.size() != 4) {
        return QColor::fromString(value);
    }
    int channels[4] = {0, 0, 0, 255};
    for (int i = 0; i < parts.size(); ++i) {
        bool ok = false;
        channels[i] = parts.at(i).trimmed().toInt(&ok);
        if (!ok) {
            return QColor();
        }
    }
    return QColor(channels[0], channels[1], channels[2], channels[3]);
}

Outline::Outline()
{
    loadConfig();

    qInfo("kosmic-outline: loaded, thickness=%g radius=%g color=%s",
          m_thickness, m_radius, qPrintable(m_color.name(QColor::HexArgb)));

    Workspace *ws = workspace();
    if (!ws) {
        qWarning("kosmic-outline: no workspace, doing nothing");
        return;
    }

    connect(ws, &Workspace::windowAdded, this, &Outline::onWindowAdded);
    connect(ws, &Workspace::windowRemoved, this, &Outline::onWindowRemoved);
    // The covered window can change while the rect does not (raise, close, desktop switch).
    connect(ws, &Workspace::stackingOrderChanged, this, &Outline::refresh);
    for (Window *window : ws->windows()) {
        connect(window, &Window::frameGeometryChanged, this, &Outline::retryIfDetached);
    }
    connect(ws, &Workspace::currentDesktopChanged, this, &Outline::refresh);

    // With no colour written the line is the scheme's accent, so scheme changes must reach it (cosmic-comp: theme.rs:23).
    m_schemeWatcher = KConfigWatcher::create(
        KSharedConfig::openConfig(QStringLiteral("kdeglobals"), KConfig::NoGlobals));
    connect(m_schemeWatcher.data(), &KConfigWatcher::configChanged, this,
            [this](const KConfigGroup &group, const QByteArrayList &) {
                // Only General (AccentColor) and Colors:* can change the line.
                const QString name = group.name();
                if (name != QLatin1String("General") && !name.startsWith(QLatin1String("Colors:"))) {
                    return;
                }
                const QColor before = m_color;
                loadConfig();
                if (m_color == before) {
                    return;
                }
                if (m_debug) {
                    qDebug("kosmic-outline: colour scheme changed, line is now %s",
                           qPrintable(m_color.name(QColor::HexArgb)));
                }
                // The item bakes its colour in when built; rebuilding repaints it.
                detach();
                refresh();
            });

    // Last: once this returns, the tiler can call in at any moment.
    if (!QDBusConnection::sessionBus().registerObject(
            s_dbusPath, this, QDBusConnection::ExportScriptableInvokables)) {
        qWarning("kosmic-outline: could not take %s on the session bus; no selection will arrive",
                 qPrintable(QString(s_dbusPath)));
    }

    // A plugin loaded into a running session gets no selection until the tiler resends;
    // the applet invokes KosmicReloadSettings, which drops the tiler's deduplication.
}

Outline::~Outline()
{
    // Unregister first: a reload (how the applet applies a thickness) would find the path taken and go deaf.
    QDBusConnection::sessionBus().unregisterObject(s_dbusPath);
    detach();
}

void Outline::SetSelection(const QString &rect)
{
    const std::optional<RectF> before = m_selection;
    m_selection.reset();

    const QStringList parts = rect.split(QLatin1Char(','), Qt::SkipEmptyParts);
    if (parts.size() == 4) {
        qreal values[4] = {0, 0, 0, 0};
        bool ok = true;
        for (int i = 0; i < 4 && ok; ++i) {
            values[i] = parts.at(i).trimmed().toDouble(&ok);
        }
        if (ok && values[2] > 0 && values[3] > 0) {
            m_selection = RectF(values[0], values[1], values[2], values[3]);
        }
    }

    if (m_debug && m_selection != before) {
        if (m_selection) {
            qDebug("kosmic-outline: selection %g,%g %gx%g", m_selection->x(), m_selection->y(),
                   m_selection->width(), m_selection->height());
        } else {
            qDebug("kosmic-outline: selection cleared ('%s')", qPrintable(rect));
        }
    }
    refresh();
}

void Outline::loadConfig()
{
    // Fresh KConfig, not KSharedConfig: the shared instance does not see keys written after session start.
    KConfig file(QStringLiteral("kwinrc"), KConfig::NoGlobals);
    const KConfigGroup config = file.group(QStringLiteral("Plugin-kosmic-outline"));
    // 3 is cosmic-theme's active_hint width (backend/render/mod.rs:801).
    m_thickness = config.readEntry("Thickness", 3);
    m_radius = config.readEntry("Radius", -1);
    m_fallbackRadius = qMax(0, config.readEntry("FallbackRadius", 8));
    m_debug = config.readEntry("Debug", false);

    // Unset colour means the accent, as in cosmic-comp (theme.rs:15). General/AccentColor first: Plasma
    // keeps the chosen accent there, while Colors:Selection on disk does not follow it.
    m_color = parseColor(config.readEntry("Color", QString()));
    if (!m_color.isValid()) {
        KConfig scheme(QStringLiteral("kdeglobals"), KConfig::NoGlobals);
        m_color = parseColor(scheme.group(QStringLiteral("General")).readEntry("AccentColor", QString()));
        if (!m_color.isValid()) {
            const KConfigGroup colors = scheme.group(QStringLiteral("Colors:Selection"));
            m_color = parseColor(colors.readEntry("BackgroundNormal", QString()));
        }
    }
    if (!m_color.isValid()) {
        m_color = QColor(Qt::white);
    }
    const int opacity = qBound(0, config.readEntry("Opacity", 100), 100);
    m_color.setAlphaF(m_color.alphaF() * opacity / 100.0);
}

void Outline::onWindowAdded(Window *window)
{
    if (m_debug) {
        qDebug("kosmic-outline: + '%s' class='%s' popup=%d unmanaged=%d normal=%d internal=%d dock=%d osd=%d notification=%d",
               qPrintable(window->caption()), qPrintable(window->resourceClass()),
               window->isPopupWindow(), window->isUnmanaged(), window->isNormalWindow(),
               window->isInternal(), window->isDock(), window->isOnScreenDisplay(),
               window->isNotification());
    }
    // KWin places a new window before the tiler moves it, and the selection can arrive in between.
    connect(window, &Window::frameGeometryChanged, this, &Outline::retryIfDetached);
    refresh();
}

// The selection can arrive while the window's frame geometry is still the old one (KWin 6.7.5), leaving nothing
// to anchor to and nothing that would look again; any window moving retries, but only while detached.
void Outline::retryIfDetached()
{
    if (m_selection && !m_item) {
        refresh();
    }
}

void Outline::onWindowRemoved(Window *window)
{
    // Item::~Item does not reparent children (scene/item.cpp:50): a still-attached item would dangle.
    if (window == m_anchor) {
        detach();
    }
    refresh();
}

Window *Outline::anchorFor(const RectF &sel) const
{
    Workspace *ws = workspace();
    if (!ws) {
        return nullptr;
    }
    const QList<Window *> &stack = ws->stackingOrder();
    for (auto it = stack.crbegin(); it != stack.crend(); ++it) {
        Window *window = *it;
        // isInternal first: the drop zone, tab bars and mode OSD are internal (OverlayLayer) windows,
        // and a line parented to one crosses every menu.
        if (window->isInternal() || window->isDeleted() || window->isUnmanaged() ||
            !window->isNormalWindow()) {
            continue;
        }
        if (window->isMinimized() || window->isHidden() || !window->isOnCurrentDesktop()) {
            continue;
        }
        if (window->isPopupWindow() || window->isDock() || window->isDesktop() ||
            window->isOnScreenDisplay() || window->isNotification()) {
            continue;
        }
        // Half of the window's own area inside the selection: focusdim's rule, which must agree on what is covered.
        const RectF g = window->frameGeometry();
        if (g.width() <= 0 || g.height() <= 0) {
            continue;
        }
        const RectF overlap = g.intersected(sel);
        if (overlap.isEmpty()) {
            continue;
        }
        if (overlap.width() * overlap.height() * 2 >= g.width() * g.height()) {
            return window;
        }
    }
    return nullptr;
}

BorderOutline Outline::outlineFor(const Window *anchor) const
{
    // The radius is the inner one (itemrenderer_opengl.cpp:285-287); the outer curve widens by one thickness itself.
    if (m_radius < 0) {
        // KWin reports no radius for client-rounded windows (Chromium, GTK, Electron); only zero is replaced.
        const BorderRadius r = anchor->borderRadius();
        if (anchor->isDecorated()) {
            // Breeze rounds the title bar top but KWin reports 0 there: borrow the bottom radius, or the fallback.
            const qreal below = qMax(r.bottomLeft(), r.bottomRight());
            const qreal top = below > 0 ? below : m_fallbackRadius;
            return BorderOutline(m_thickness, m_color,
                                 BorderRadius(r.topLeft() > 0 ? r.topLeft() : top,
                                              r.topRight() > 0 ? r.topRight() : top,
                                              r.bottomRight(), r.bottomLeft()));
        }
        if (r.isNull()) {
            return BorderOutline(m_thickness, m_color, BorderRadius(m_fallbackRadius));
        }
        return BorderOutline(m_thickness, m_color, r);
    }
    return BorderOutline(m_thickness, m_color, BorderRadius(m_radius));
}

void Outline::detach()
{
    // The item first and the connections after: destroying it is what takes it off the WindowItem.
    m_item.reset();
    disconnect(m_anchorGeometry);
    disconnect(m_anchorClosed);
    disconnect(m_anchorRadius);
    m_anchorGeometry = {};
    m_anchorClosed = {};
    m_anchorRadius = {};
    m_anchor = nullptr;
}

void Outline::refresh()
{
    const std::optional<RectF> &sel = m_selection;
    if (!sel) {
        if (m_item && m_debug) {
            qDebug("kosmic-outline: nothing selected");
        }
        detach();
        return;
    }

    Window *anchor = anchorFor(*sel);
    WindowItem *host = anchor ? anchor->windowItem() : nullptr;
    if (!host) {
        if (m_debug) {
            qDebug("kosmic-outline: no window under %gx%g+%g+%g, waiting for one",
                   sel->width(), sel->height(), sel->x(), sel->y());
        }
        detach();
        return;
    }

    if (anchor != m_anchor) {
        detach();
        m_anchor = anchor;
        // Item geometry is relative to the WindowItem, which sits at the window's position (windowitem.cpp:200).
        m_anchorGeometry = connect(anchor, &Window::frameGeometryChanged, this, &Outline::refresh);
        // Closed, not destroyed: ~Window runs after its WindowItem is gone. windowRemoved alone misses unmanaged windows.
        m_anchorClosed = connect(anchor, &Window::closed, this, &Outline::detach);
        m_anchorRadius = connect(anchor, &Window::borderRadiusChanged, this, &Outline::refresh);
    }

    const RectF inner = sel->translated(-anchor->pos().x(), -anchor->pos().y());
    if (m_debug) {
        const RectF fg = anchor->frameGeometry();
        qDebug("kosmic-outline: refresh anchor='%s' frame=%gx%g+%g+%g sel=%gx%g+%g+%g inner=%gx%g+%g+%g item=%d",
               qPrintable(anchor->caption()), fg.width(), fg.height(), fg.x(), fg.y(),
               sel->width(), sel->height(), sel->x(), sel->y(),
               inner.width(), inner.height(), inner.x(), inner.y(), m_item ? 1 : 0);
    }
    const BorderOutline outline = outlineFor(anchor);
    if (!m_item) {
        m_item = std::make_unique<OutlinedBorderItem>(inner, outline, host);
        // Above the contents: a client that refused its size draws past the slot edge, and the line must win.
        m_item->setZ(1);
        m_item->setVisible(true);
        if (m_debug) {
            int above = 0;
            if (Workspace *ws = workspace()) {
                const QList<Window *> &stack = ws->stackingOrder();
                for (int i = stack.indexOf(anchor) + 1; i > 0 && i < stack.size(); ++i) {
                    ++above;
                }
            }
            qDebug("kosmic-outline: attached to '%s' (popup=%d unmanaged=%d normal=%d) sel=%gx%g+%g+%g, %d windows above it",
                   qPrintable(anchor->caption()), anchor->isPopupWindow(), anchor->isUnmanaged(),
                   anchor->isNormalWindow(), sel->width(), sel->height(), sel->x(), sel->y(), above);
        }
    } else {
        m_item->setOutline(outline);
        m_item->setInnerRect(inner);
    }
}

} // namespace KWin

#include "moc_outline.cpp"
