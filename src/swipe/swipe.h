#pragma once

#include "kwin/plugin.h"

#include <QPointer>

#include <memory>
#include <vector>

class QAction;

namespace KWin
{

class VirtualDesktop;

// KWin's own swipe only walks existing desktops and cancels at the edge (virtualdesktops.cpp:858), so this registers
// the same swipes beside it. An abandoned workspace goes after the slide ends: removing it mid-slide collapses the effect's grid.
class Swipe : public Plugin
{
    Q_OBJECT

public:
    Swipe();
    ~Swipe() override;

private:
    void reach(bool right, qreal progress);
    void released();
    void dropIfUnused();

    // Owning the actions is the unregistering: GlobalShortcutsManager forgets a shortcut when its action dies.
    std::vector<std::unique_ptr<QAction>> m_actions;

    bool m_reached = false;

    QPointer<VirtualDesktop> m_made;
    QMetaObject::Connection m_waitForSlide;
};

} // namespace KWin
