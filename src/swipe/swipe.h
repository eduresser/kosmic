/*
    KOSMIC: an empty workspace past the end, made when the swipe reaches for it.
*/

#pragma once

#include "kwin/plugin.h"

#include <QPointer>

#include <memory>
#include <vector>

class QAction;

namespace KWin
{

class VirtualDesktop;

/**
 * The half of the dynamic workspaces a KWin script cannot do: making the empty workspace past the
 * edge when the touchpad's swipe asks for one.
 *
 * The keys mint it themselves -- goWorkspace() in the tiler creates the workspace and then
 * switches to it. The three-finger swipe is KWin's own (VirtualDesktopManager::initShortcuts,
 * virtualdesktops.cpp:784), and it only ever walks the desktops that exist: on release it asks
 * toLeft()/toRight() for a neighbour and, at the edge, gets the current desktop back and calls the
 * gesture cancelled (gestureReleasedX, :858). The script hears of a swipe only as
 * `currentDesktopChanged`, after the switch -- and at the edge there is no switch to hear of.
 *
 * So this registers the same swipes beside KWin's. The gesture recognizer hands every registered
 * gesture with the right finger count and axis the same progress (gestures.cpp:211), so both see
 * the fingers move. When the fingers reach past an edge from an occupied workspace, this makes the
 * workspace there before they are lifted; KWin's release then finds a neighbour and switches to it
 * like any other. If the swipe is abandoned the workspace is removed again, once the slide that
 * takes the view back has finished -- a desktop removed mid-slide collapses the grid the effect
 * is reading, which is the same reason the tiler waits.
 *
 * The rule for "occupied" is the tiler's holdsWorkspace(), transcribed, because this has to answer
 * before the script could be asked.
 */
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

    // Owned here, and that is the whole of unregistering: GlobalShortcutsManager forgets a shortcut
    // when its action is destroyed (globalshortcuts.cpp:125), and the gesture goes with it.
    std::vector<std::unique_ptr<QAction>> m_actions;

    // One workspace per swipe at most. Reset when the gesture ends, which is when its action fires.
    bool m_reached = false;

    // The workspace this made and nobody has walked into yet.
    QPointer<VirtualDesktop> m_made;
    QMetaObject::Connection m_waitForSlide;
};

} // namespace KWin
