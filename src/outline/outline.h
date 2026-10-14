/*
    KOSMIC: the active hint, drawn where cosmic-comp draws it.
*/

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

/**
 * COSMIC's active hint: a line around the selected tile, inside the compositor.
 *
 * This is a plugin rather than part of the KWin script because a script can only draw by opening a
 * window, and `belongsToLayer` answers `if (isUnmanaged() || isInternal()) return OverlayLayer;`
 * before it looks at a window type -- so every overlay a script builds is above every menu,
 * whatever type it asks for.
 *
 * KWin draws its own decoration outlines through the scene graph: `DecorationItem::updateOutline`
 * builds an `OutlinedBorderItem` with the thickness, colour and corner radius KDecoration3 asked
 * for (scene/decorationitem.cpp:466), and `ItemRendererOpenGL::createRenderNode` renders it with
 * `ShaderTrait::Border`, a shader with per-corner radii and antialiasing
 * (scene/itemrenderer_opengl.cpp:271). A plugin linked against libkwin can use the same door, and
 * the hint stops being a window: it is a child item of the selected window's own `WindowItem`, so
 * a menu stacked above that window is painted afterwards and covers the line.
 *
 * The selection arrives from the tiler over D-Bus -- SetSelection with "x,y,w,h", or an empty
 * string for none. A string and not four integers, which is the one odd thing in the interface:
 * KWin's DBusCall marshals whatever QVariant types QML's numbers happen to carry, and an integral
 * JS number is an int or a double depending on how V4 is holding it. A signature that does not
 * match fails at the far end with nothing said on either side. One string has one signature.
 *
 * It is not read off a marker window, and the reason is the Overview. Every window a KWin script
 * opens is Normal to the compositor -- InternalWindow::windowType() returns WindowType::Normal
 * unconditionally (internalwindow.cpp:154) -- and the Overview's filter drops only Dock, Desktop
 * and the notification types, so a marker is listed in Meta+W beside the real windows with no flag
 * or property that can take it off. The tiler still builds one where focusdim is enabled, because
 * a scripted effect cannot receive a D-Bus call: `callDBus` only goes out.
 *
 * Two limits, both measured rather than assumed:
 *
 *  - Only the OpenGL renderer draws this. `ItemRendererQPainter` has no branch for
 *    `OutlinedBorderItem`, so a software-rendered session gets no line and no error.
 *
 *  - The line lives in the gap around the slot, so two neighbours' hints meet in the seam instead
 *    of overlapping. With `gaps.inner` smaller than twice the thickness they overlap, and with
 *    `gaps.outer` at zero the line on a screen edge is drawn off it.
 */
class Outline : public Plugin
{
    Q_OBJECT

    // Declared, not derived. Without it `qDBusInterfaceFromMetaObject` falls back to the reversed
    // `organizationDomain`, the `applicationName` and the class, which inside kwin_wayland comes
    // out as "org.kde.kwin.KWin.Outline" -- a name this project does not own, which moves if KWin
    // renames itself. A caller asking for the wrong one gets "No such interface", which `DBusCall`
    // never reports because it reads no reply: the line simply never appears.
    Q_CLASSINFO("D-Bus Interface", "io.github.eduresser.kosmic.Selection")

public:
    Outline();
    ~Outline() override;

    /**
     * The channel. Called by the tiler with "x,y,w,h" in scene coordinates, or with an empty
     * string for "nothing is selected" -- which is also what anything it cannot parse means,
     * because a reader that does not understand what it was told must draw nothing rather than
     * guess. Scriptable so that `QDBusConnection::ExportScriptableInvokables` finds it.
     */
    Q_SCRIPTABLE void SetSelection(const QString &rect);

private:
    void loadConfig();
    void onWindowAdded(Window *window);
    void onWindowRemoved(Window *window);
    void retryIfDetached();
    void refresh();
    void detach();

    // The window the line hangs off: the topmost one the selection covers. Topmost, so the other
    // windows of a selected group cannot be painted over the line.
    Window *anchorFor(const RectF &sel) const;
    BorderOutline outlineFor(const Window *anchor) const;

    // The selected rect in scene coordinates, or nothing. Held rather than looked up: the tiler
    // pushes it and nobody else can, so this is the whole of what the plugin knows about the
    // selection between one call and the next.
    std::optional<RectF> m_selection;
    QPointer<Window> m_anchor;
    QMetaObject::Connection m_anchorGeometry;
    QMetaObject::Connection m_anchorClosed;
    QMetaObject::Connection m_anchorRadius;
    // Owned here and nowhere else: Item takes a *visual* parent and not a QObject one
    // (scene/item.cpp:45), so nothing deletes this for us -- and it has to be gone before the
    // WindowItem it hangs off is, or that item's destructor leaves a dangling parent behind.
    std::unique_ptr<OutlinedBorderItem> m_item;

    // Held for its lifetime and nothing else: KConfigWatcher stops reporting when the last
    // reference to it goes, so this being a member *is* the subscription.
    KConfigWatcher::Ptr m_schemeWatcher;

    qreal m_thickness = 3;
    // Negative means "the corner the window itself has", which is the only radius that can be
    // right for every theme: Breeze rounds its windows and a square theme does not. A window
    // that has no decoration to ask gets a fixed one (outlineFor).
    qreal m_radius = -1;
    // The corner given to a window that has no decoration to ask and reports none (outlineFor).
    qreal m_fallbackRadius = 8;
    QColor m_color;
    bool m_debug = false;
};

} // namespace KWin
