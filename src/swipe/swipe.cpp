/*
    KOSMIC: an empty workspace past the end, made when the swipe reaches for it.
*/

#include "swipe.h"

#include "kwin/effect/effecthandler.h"
#include "kwin/input.h"
#include "kwin/virtualdesktops.h"
#include "kwin/window.h"
#include "kwin/workspace.h"

#include <QAction>

namespace KWin
{

namespace
{
// How far the fingers travel before this acts, as KWin's progress (200 px is 1.0). Past the 5 px
// that locks the axis (gestures.cpp:170), so a swipe that starts out diagonal has been told which
// way it goes before anything is made.
constexpr qreal s_reachThreshold = 0.1;

// The tiler's holdsWorkspace(): a normal window, listed in the pager, on this desktop and not on
// all of them. Minimized windows count, as they do there.
bool holdsWindow(VirtualDesktop *desktop)
{
    const auto windows = workspace()->windows();
    for (Window *w : windows) {
        if (!w->isDeleted() && w->isNormalWindow() && !w->skipPager() && !w->isOnAllDesktops()
            && w->isOnDesktop(desktop)) {
            return true;
        }
    }
    return false;
}
} // namespace

Swipe::Swipe()
{
    // KWin's own mapping, not a choice: a swipe to the left offsets the view by +x, and a positive
    // offset is released towards toRight() (virtualdesktops.cpp:799, :866).
    const auto add = [this](bool touchscreen, SwipeDirection direction, uint fingers) {
        auto action = std::make_unique<QAction>();
        connect(action.get(), &QAction::triggered, this, &Swipe::released);
        const bool right = direction == SwipeDirection::Left;
        const auto progress = [this, right](qreal p) {
            reach(right, p);
        };
        if (touchscreen) {
            input()->registerTouchscreenSwipeShortcut(direction, fingers, action.get(), progress);
        } else {
            input()->registerTouchpadSwipeShortcut(direction, fingers, action.get(), progress);
        }
        m_actions.push_back(std::move(action));
    };
    for (uint fingers : {3u, 4u}) {
        add(false, SwipeDirection::Left, fingers);
        add(false, SwipeDirection::Right, fingers);
    }
    add(true, SwipeDirection::Left, 3);
    add(true, SwipeDirection::Right, 3);
}

Swipe::~Swipe()
{
    disconnect(m_waitForSlide);
}

void Swipe::reach(bool right, qreal progress)
{
    if (m_reached || progress < s_reachThreshold) {
        return;
    }
    m_reached = true;

    VirtualDesktopManager *vdm = VirtualDesktopManager::self();
    // A grid of several rows has no single "past the end" to put a workspace in.
    if (vdm->rows() != 1) {
        return;
    }
    VirtualDesktop *current = vdm->currentDesktop();
    if (!current) {
        return;
    }
    // A neighbour already there is KWin's to walk into.
    VirtualDesktop *next = right ? vdm->toRight(current, false) : vdm->toLeft(current, false);
    if (next != current) {
        return;
    }
    // The keys' rule (goWorkspace): walking off an empty workspace at the end makes nothing, or
    // every swipe would mint another.
    if (!holdsWindow(current)) {
        return;
    }
    dropIfUnused();
    m_made = vdm->createVirtualDesktop(right ? vdm->count() : 0);
}

// The action fires when the gesture ends, triggered or cancelled, queued behind KWin's own -- which
// was registered first, so by now KWin has either switched or called the swipe off.
void Swipe::released()
{
    m_reached = false;
    dropIfUnused();
}

void Swipe::dropIfUnused()
{
    disconnect(m_waitForSlide);
    VirtualDesktop *made = m_made;
    if (!made) {
        return;
    }
    VirtualDesktopManager *vdm = VirtualDesktopManager::self();
    // Walked into, or filled: the tiler's from here on.
    if (made == vdm->currentDesktop() || holdsWindow(made)) {
        m_made = nullptr;
        return;
    }
    // The slide taking the view back holds the effect active until it lands (slide.cpp:428).
    if (effects && effects->hasActiveFullScreenEffect()) {
        m_waitForSlide = connect(effects, &EffectsHandler::hasActiveFullScreenEffectChanged, this, &Swipe::dropIfUnused);
        return;
    }
    m_made = nullptr;
    vdm->removeVirtualDesktop(made);
}

} // namespace KWin
