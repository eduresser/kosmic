#pragma once

#include "kwin/plugin.h"
// Pulls scene/borderradius.h and core/rect.h in with it, which is where RectF comes from.
#include "kwin/scene/borderoutline.h"

#include <KConfigWatcher>
#include <QColor>
#include <QString>
#include <QPointer>

#include <memory>
#include <optional>

namespace KWin
{

// KWin 6.6 introduced its own RectF; 6.5 still uses QRectF for the same geometry.
#if !__has_include(<kwin/core/rect.h>)
using RectF = QRectF;
#endif

class OutlinedBorderItem;
class Window;

// A plugin, not a script: every window a script opens lands in OverlayLayer (belongsToLayer), above menus.
// Only the OpenGL renderer draws it; ItemRendererQPainter has no branch for OutlinedBorderItem.
class Outline : public Plugin
{
    Q_OBJECT

    // Declared because the derived name inside kwin_wayland is "org.kde.kwin.KWin.Outline"; a wrong name
    // fails silently, since DBusCall reads no reply.
    Q_CLASSINFO("D-Bus Interface", "io.github.eduresser.kosmic.Selection")

public:
    Outline();
    ~Outline() override;

    // "x,y,w,h" as one string: DBusCall marshals QML numbers as int or double unpredictably, and a signature
    // mismatch fails silently. Empty or unparsable means nothing selected.
    Q_SCRIPTABLE void SetSelection(const QString &rect);

private:
    void loadConfig();
    void onWindowAdded(Window *window);
    void onWindowRemoved(Window *window);
    void retryIfDetached();
    void refresh();
    void detach();

    // Topmost, so other windows of a selected group cannot paint over the line.
    Window *anchorFor(const RectF &sel) const;
    BorderOutline outlineFor(const Window *anchor) const;

    std::optional<RectF> m_selection;
    QPointer<Window> m_anchor;
    QMetaObject::Connection m_anchorGeometry;
    QMetaObject::Connection m_anchorClosed;
    QMetaObject::Connection m_anchorRadius;
    // Item takes a visual parent, not a QObject one: nothing deletes it, and it must go before its WindowItem.
    std::unique_ptr<OutlinedBorderItem> m_item;

    // Being a member is the subscription: KConfigWatcher stops reporting when the last reference goes.
    KConfigWatcher::Ptr m_schemeWatcher;

    qreal m_thickness = 3;
    // Negative: the window's own corner, since themes differ.
    qreal m_radius = -1;
    qreal m_fallbackRadius = 8;
    QColor m_color;
    bool m_debug = false;
};

} // namespace KWin
