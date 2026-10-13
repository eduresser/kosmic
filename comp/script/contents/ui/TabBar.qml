// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// The tab bar of one stack. KDE 4.4 drew window tabs inside the title bar (Oxygen's [Windeco] UseTabs);
// since Plasma 5 dropped that, the stacked windows give up their decoration and this takes its place.
// A KWin script can only put something on the screen through a PlasmaCore.Dialog -- the pattern
// Krohnkite's layout popup uses -- so the bar is a dialog the script moves over the top of the slot.
import QtQuick
import org.kde.plasma.core as PlasmaCore
import org.kde.kirigami as Kirigami

PlasmaCore.Dialog {
    id: bar

    // Named so the focusdim effect can tell our overlays apart. A bar belongs to the slot under it
    // and dims with it; the selection marker and the drop zone never dim. An empty window class is
    // what all three have in common, so the name is what separates them.
    title: "kosmic-tabbar"

    type: PlasmaCore.Dialog.OnScreenDisplay
    flags: Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus
    location: PlasmaCore.Types.Floating
    backgroundHints: PlasmaCore.Dialog.NoBackground   // the bar is the title bar, not a floating panel
    outputOnly: false                                 // tabs are clickable
    visible: false

    property int stackId: -1
    property var tabs: []
    property int activeIndex: 0
    property int barWidth: 0
    property int barHeight: 28

    signal tabActivated(int stackId, int index)
    signal tabClosed(int stackId, int index)

    function apply(id, rect, list, active) {
        bar.stackId = id;
        bar.tabs = list;
        bar.activeIndex = active;
        bar.barWidth = rect.width;
        bar.barHeight = rect.height;
        bar.x = rect.x;
        bar.y = rect.y;
        bar.visible = true;
    }

    mainItem: Item {
        id: content
        width: bar.barWidth
        height: bar.barHeight

        // Breeze ties its header colours to the title bar, which is what this strip stands in for.
        Kirigami.Theme.colorSet: Kirigami.Theme.Header
        Kirigami.Theme.inherit: false

        Rectangle {
            anchors.fill: parent
            color: Kirigami.Theme.backgroundColor
        }

        Row {
            anchors.fill: parent
            Repeater {
                model: bar.tabs
                delegate: Item {
                    id: tab
                    required property var modelData
                    required property int index
                    readonly property bool current: index === bar.activeIndex

                    width: Math.round(bar.barWidth / Math.max(1, bar.tabs.length))
                    height: bar.barHeight

                    Rectangle {
                        anchors.fill: parent
                        color: tab.current ? Kirigami.Theme.backgroundColor : Kirigami.Theme.alternateBackgroundColor
                    }
                    // a hairline between tabs, the way a title bar is divided when it holds several
                    Rectangle {
                        anchors { right: parent.right; top: parent.top; bottom: parent.bottom }
                        width: 1
                        visible: tab.index < bar.tabs.length - 1
                        color: Kirigami.Theme.textColor
                        opacity: 0.12
                    }
                    Rectangle {
                        anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
                        height: 2
                        visible: tab.current
                        color: Kirigami.Theme.highlightColor
                    }

                    MouseArea {
                        anchors.fill: parent
                        acceptedButtons: Qt.LeftButton | Qt.MiddleButton
                        onClicked: (mouse) => {
                            if (mouse.button === Qt.MiddleButton) bar.tabClosed(bar.stackId, tab.index);
                            else bar.tabActivated(bar.stackId, tab.index);
                        }
                    }

                    Kirigami.Icon {
                        id: tabIcon
                        anchors.left: parent.left
                        anchors.leftMargin: Kirigami.Units.smallSpacing * 2
                        anchors.verticalCenter: parent.verticalCenter
                        width: Kirigami.Units.iconSizes.small
                        height: width
                        source: tab.modelData.icon
                        fallback: tab.modelData.iconName
                        opacity: tab.current ? 1.0 : 0.7
                    }
                    Text {
                        anchors.left: tabIcon.right
                        anchors.leftMargin: Kirigami.Units.smallSpacing
                        anchors.right: closeButton.visible ? closeButton.left : parent.right
                        anchors.rightMargin: Kirigami.Units.smallSpacing
                        anchors.verticalCenter: parent.verticalCenter
                        text: tab.modelData.title
                        elide: Text.ElideRight
                        color: Kirigami.Theme.textColor
                        opacity: tab.current ? 1.0 : 0.7
                        font: Kirigami.Theme.defaultFont
                    }
                    Kirigami.Icon {
                        id: closeButton
                        anchors.right: parent.right
                        anchors.rightMargin: Kirigami.Units.smallSpacing
                        anchors.verticalCenter: parent.verticalCenter
                        width: Kirigami.Units.iconSizes.small
                        height: width
                        visible: tab.current && tab.width > Kirigami.Units.gridUnit * 4
                        source: "window-close-symbolic"
                        opacity: closeArea.containsMouse ? 1.0 : 0.6
                        MouseArea {
                            id: closeArea
                            anchors.fill: parent
                            anchors.margins: -Kirigami.Units.smallSpacing
                            hoverEnabled: true
                            onClicked: bar.tabClosed(bar.stackId, tab.index)
                        }
                    }
                }
            }
        }
    }
}
