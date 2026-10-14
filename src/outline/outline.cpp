/*
    KOSMIC: the active hint, drawn where cosmic-comp draws it.
*/

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

// Where the tiler calls. The object goes on the session bus connection KWin already holds, which
// is the one carrying the well-known name `org.kde.KWin` -- so the address is that service and
// this path, and the plugin needs no name of its own. contents/ui/main.qml has the same three
// strings and there is no third place either side is written.
static const QLatin1String s_dbusPath("/kosmic/Selection");

// kdeglobals stores a colour as "r,g,b" or "r,g,b,a" and kwinrc would take a "#rrggbb" written by
// hand, so both are read here rather than linking KF6::ConfigGui for its QColor conversion -- that
// one is installed by a static initializer, which is a link-order question in exchange for three
// lines.
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
        return QColor::fromString(value);   // a colour name, or nothing
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

    // One line per session, always. A plugin that says nothing is indistinguishable from a plugin
    // that did not load, and this module has already paid an hour for exactly that confusion.
    qInfo("kosmic-outline: loaded, thickness=%g radius=%g color=%s",
          m_thickness, m_radius, qPrintable(m_color.name(QColor::HexArgb)));

    // Plugins are created after the workspace and after the renderer -- createPlugins() is the
    // line below createWorkspace() in ApplicationWayland::performStartup -- so this is never null.
    Workspace *ws = workspace();
    if (!ws) {
        qWarning("kosmic-outline: no workspace, doing nothing");
        return;
    }

    connect(ws, &Workspace::windowAdded, this, &Outline::onWindowAdded);
    connect(ws, &Workspace::windowRemoved, this, &Outline::onWindowRemoved);
    // The selection can start covering a different window without the rect changing: a window
    // raised inside a selected group, one closed out of it, a desktop switched under it.
    connect(ws, &Workspace::stackingOrderChanged, this, &Outline::refresh);
    for (Window *window : ws->windows()) {
        connect(window, &Window::frameGeometryChanged, this, &Outline::retryIfDetached);
    }
    connect(ws, &Workspace::currentDesktopChanged, this, &Outline::refresh);

    // A colour scheme change has to reach the line, because with no colour written the line *is*
    // the scheme's accent. cosmic-comp watches three configs for this -- the dark theme, the
    // light theme and the mode -- and repaints (src/theme.rs:23). KDE keeps all three in one
    // file, so one watcher covers it.
    //
    // KConfigWatcher and not a timer or a file watch: KConfig broadcasts a change over D-Bus when
    // the writer asks it to, and Plasma's colour applier does ask, which is how every running
    // application recolours itself at once. Reading the whole configuration again rather than
    // only the colour -- kwinrc has not changed, so this costs one parse and keeps a single path
    // that decides what the line looks like.
    m_schemeWatcher = KConfigWatcher::create(
        KSharedConfig::openConfig(QStringLiteral("kdeglobals"), KConfig::NoGlobals));
    connect(m_schemeWatcher.data(), &KConfigWatcher::configChanged, this,
            [this](const KConfigGroup &group, const QByteArrayList &) {
                // General carries AccentColor, Colors:Selection the scheme's own. Anything else in
                // kdeglobals -- fonts, icon theme, every toolbar setting -- cannot move this line.
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
                // The item takes its colour from outlineFor() when it is built or moved, so the
                // one already on screen has the old one baked in. Rebuilding is what repaints it.
                detach();
                refresh();
            });

    // Last, and only now that everything it can reach is built: once this returns the tiler can
    // call in from another process at any moment.
    if (!QDBusConnection::sessionBus().registerObject(
            s_dbusPath, this, QDBusConnection::ExportScriptableInvokables)) {
        // Worth a line of its own. The plugin would otherwise load, log that it loaded, and never
        // draw anything, with every other thing it does working perfectly.
        qWarning("kosmic-outline: could not take %s on the session bus; no selection will arrive",
                 qPrintable(QString(s_dbusPath)));
    }

    // Nothing is drawn until the tiler says what is selected, and it says so on every change --
    // which after a login is immediate. The case that is not immediate is this plugin being
    // loaded into a session already running, as the applet does when the hint's thickness or
    // colour changes: the tiler has already published and will not again until the selection
    // moves. The applet invokes KosmicReloadSettings after the load for exactly that, and
    // reloadSettings() drops the tiler's deduplication so the same rect is sent again.
}

Outline::~Outline()
{
    // Before detach(), and before anything else: an unload leaves the object registered otherwise,
    // and the load that follows it -- which is how the applet applies a thickness -- would find
    // the path taken and go deaf for the rest of the session.
    QDBusConnection::sessionBus().unregisterObject(s_dbusPath);
    detach();
}

// ---- the channel ----

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
        // A rect with no area is not a selection, whatever it was meant to be. This is the one
        // test left of the parked-marker pair the window channel needed, and it is kept because
        // the tiler is not the only thing that can call here.
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
    // A fresh KConfig and not KSharedConfig: the shared one hands back the instance KWin is
    // already holding, so a key written into kwinrc after the session started stays invisible
    // until something reparses it -- measured, after `kwriteconfig6 ... Debug true` plus an
    // unload and a load changed nothing. Reading from disk here is what makes the line tunable
    // by unloading and loading the plugin instead of by logging out.
    KConfig file(QStringLiteral("kwinrc"), KConfig::NoGlobals);
    const KConfigGroup config = file.group(QStringLiteral("Plugin-kosmic-outline"));
    // 3 is upstream's: cosmic-theme's `active_hint`, which backend/render/mod.rs:801 uses as the
    // outline width in logical pixels. The QML hint this replaces used the same number.
    m_thickness = config.readEntry("Thickness", 3);
    m_radius = config.readEntry("Radius", -1);
    m_fallbackRadius = qMax(0, config.readEntry("FallbackRadius", 8));
    m_debug = config.readEntry("Debug", false);

    // The accent, when nothing is written here. This is upstream's rule and not a preference:
    // cosmic-comp's whole resolution of the hint colour is
    //
    //     if let Some(hint) = theme.window_hint { hint } else { theme.accent_color() }
    //
    // (src/theme.rs:15), so an unset colour means the theme's accent and the written one is an
    // override. This file used to read Colors:Window/ForegroundNormal instead, with a comment
    // saying the accent "reads as selected rather than as the keyboard is here" -- which was a
    // judgement made without checking, and upstream had already made the other one.
    //
    // AccentColor first and the scheme's selection second, because Plasma keeps a chosen accent
    // in kdeglobals' General group and tints the scheme with it at run time; the Selection group
    // on disk is the scheme's own and does not move when the accent does. Reading the General key
    // first is what makes this the colour the user actually sees as "accent".
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

// ---- what the selection covers ----

void Outline::onWindowAdded(Window *window)
{
    if (m_debug) {
        // What a menu actually is, named rather than assumed. The anchor filter turns on these
        // flags, so this is the line that says whether a given menu can be picked as one.
        qDebug("kosmic-outline: + '%s' class='%s' popup=%d unmanaged=%d normal=%d internal=%d dock=%d osd=%d notification=%d",
               qPrintable(window->caption()), qPrintable(window->resourceClass()),
               window->isPopupWindow(), window->isUnmanaged(), window->isNormalWindow(),
               window->isInternal(), window->isDock(), window->isOnScreenDisplay(),
               window->isNotification());
    }
    // A new window is placed by KWin first and moved into its slot afterwards, and the selection
    // can arrive in between: for the slot it is about to occupy, with the window still where KWin
    // put it. Hence the geometry watch below.
    connect(window, &Window::frameGeometryChanged, this, &Outline::retryIfDetached);
    // A new window can be the topmost one the selection covers, and it arrives above the stack.
    refresh();
}

// Nothing is attached while a selection exists when no window stood under it at the moment it
// arrived. The tiler publishes the slot a window is being moved to in the same breath as it moves
// it, and the window's frame geometry can still be the old one when SetSelection runs; the line
// was dropped there and nothing ever asked again, because only the anchor's own geometry was
// watched and a detached outline has no anchor. Measured on KDE Neon, KWin 6.7.5: from the fourth
// terminal on, when the new slot no longer overlaps where KWin first placed the window by half.
// Any window moving is a reason to look again, but only while detached, so an attached line costs
// nothing extra.
void Outline::retryIfDetached()
{
    if (m_selection && !m_item) {
        refresh();
    }
}

void Outline::onWindowRemoved(Window *window)
{
    // Before anything else: the item hangs off this window's WindowItem, and a WindowItem that is
    // destroyed does not reparent its children -- Item::~Item only detaches *itself*
    // (scene/item.cpp:50). Leaving the item attached is a dangling parent pointer.
    if (window == m_anchor) {
        detach();
    }
    refresh();
}

// ---- what the line hangs off ----

Window *Outline::anchorFor(const RectF &sel) const
{
    Workspace *ws = workspace();
    if (!ws) {
        return nullptr;
    }
    const QList<Window *> &stack = ws->stackingOrder();
    for (auto it = stack.crbegin(); it != stack.crend(); ++it) {
        Window *window = *it;
        // Internal first, and this one is the whole bug this filter exists for. Measured on
        // measured when the selection still arrived as a window: the anchor was that marker
        // itself. Its geometry *was* the selection, so all of its own area was inside it and it
        // won the topmost test every time; the line became a child of a window in `OverlayLayer`
        // and crossed every menu, which is the exact failure the QML outline died of reached
        // through a different door. The marker no longer carries the selection, and the test stays
        // because it was never only about the marker -- the drop zone, the tab bars and the mode
        // OSD are internal windows too, they answer `isNormalWindow()` yes and `isPopupWindow()`
        // no, and any of them can be sitting over the selected slot. `isInternal()` is the same
        // predicate `belongsToLayer` tests before it looks at a window type at all; this is that
        // rule read from the other side.
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
        // Half of the window's *own* area inside the selection, which is focusdim's rule copied
        // deliberately: the two have to agree about what the selection covers, or the line goes
        // around a window the dimming has already put in shadow. Containment fails the case
        // selectionRect() in the tiler exists for -- a client that refused its size is drawn
        // outside the slot it was given -- and bare intersection matches the neighbour it spilled
        // over as readily as the window itself.
        const RectF g = window->frameGeometry();
        if (g.width() <= 0 || g.height() <= 0) {
            continue;
        }
        const RectF overlap = g.intersected(sel);
        if (overlap.isEmpty()) {
            continue;
        }
        if (overlap.width() * overlap.height() * 2 >= g.width() * g.height()) {
            // Topmost wins, which is why this walks the stack downwards: the other windows of a
            // selected group must not be painted over the line.
            return window;
        }
    }
    return nullptr;
}

BorderOutline Outline::outlineFor(const Window *anchor) const
{
    // The radius BorderOutline carries is the *inner* one: the renderer takes the inner rect as
    // its box and this as its corner (scene/itemrenderer_opengl.cpp:285-287), so the outer curve
    // comes out one thickness wider on its own. Following the window's own radius therefore makes
    // the line trace the corner the window actually has -- rounded under Breeze, square under a
    // square theme -- instead of a number this file would have to guess.
    if (m_radius < 0) {
        // A window that draws its own frame -- Chromium, GTK, Electron -- rounds itself in the
        // client, so KWin reports no radius for it and the line would come out square around a
        // round window. Only an undecorated window is given one: a decorated window's zero is a
        // square theme saying so. The default, 8, is COSMIC's radius_s, the corner its compositor gives
        // windows; the applet's "Active border radius" writes it.
        if (anchor->borderRadius().isNull() && !anchor->isDecorated()) {
            return BorderOutline(m_thickness, m_color, BorderRadius(m_fallbackRadius));
        }
        return BorderOutline(m_thickness, m_color, anchor->borderRadius());
    }
    return BorderOutline(m_thickness, m_color, BorderRadius(m_radius));
}

// ---- drawing ----

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
        // A selection with no window under it is a slot being rebuilt, and a line around an empty
        // rectangle says less than no line at all. It is looked for again when a window moves
        // (retryIfDetached).
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
        // The item's geometry is relative to the WindowItem, which sits at the window's own
        // position (scene/windowitem.cpp:200), so the window moving changes what "relative" means.
        m_anchorGeometry = connect(anchor, &Window::frameGeometryChanged, this, &Outline::refresh);
        // Closed, not destroyed: by the time ~Window runs its WindowItem is already gone, and the
        // item has to be taken off before that. windowRemoved covers the same ground from the
        // other side; both are kept because neither alone covers an unmanaged window.
        m_anchorClosed = connect(anchor, &Window::closed, this, &Outline::detach);
        // The corner follows the window's own, which is the decoration's
        // (`Window::updateDecorationBorderRadius`), so a theme that changes its rounding while
        // the session runs changes this too. Without this the line would keep the old corner
        // until something else moved the selection.
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
        // Above the window's own contents. The line lives in the gap and so rarely meets them,
        // but a client that refused its size is drawn out over the rect's edge, and there the
        // line has to win -- it is the only thing on screen saying what the next key acts on.
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
