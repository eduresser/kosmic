// QJSEngine (V4, about ES7) rejects syntax Node accepts, such as object spread; this parses the modules
// the way contents/ui/main.qml imports them, without running the tiler.
import QtQml
import "../../script/contents/code/core.mjs" as Core
import "../../script/contents/code/kosmic-tiling.mjs" as Tiler

QtObject {
    Component.onCompleted: {
        var bad = [];
        if (Core.HORIZONTAL !== "horizontal") bad.push("core.mjs did not export HORIZONTAL");
        if (typeof Core.measure !== "function") bad.push("core.mjs did not export measure");
        if (typeof Tiler.main !== "function") bad.push("kosmic-tiling.mjs did not export main");
        if (typeof Tiler.action !== "function") bad.push("kosmic-tiling.mjs did not export action");

        var g = Core.newGroup(Core.VERTICAL, { x: 0, y: 0, w: 100, h: 100 });
        var n = Core.node(g);
        Core.appendChild(n, Core.node(Core.newMapped("a")));
        Core.appendChild(n, Core.node(Core.newMapped("b")));
        Core.addWindow(n.data, 1);
        var out = Core.measure(n, { x: 0, y: 0, w: 1000, h: 800 }, { outer: 0, inner: 8 });
        if (!out || !out.configures || out.configures.length !== 2) {
            bad.push("measure returned " + JSON.stringify(out && out.configures));
        }

        // QJSEngine warns that moveCurrentNode reads STACK_HANDLED before its const; walk the path so a TDZ
        // error surfaces here rather than on a keypress.
        var root = Core.node(Core.newGroup(Core.VERTICAL, { x: 0, y: 0, w: 1000, h: 800 }));
        var one = Core.appendChild(root, Core.node(Core.newMapped("x")));
        var two = Core.appendChild(root, Core.node(Core.newMapped("y")));
        Core.addWindow(root.data, 1);
        Core.measure(root, { x: 0, y: 0, w: 1000, h: 800 }, { outer: 0, inner: 8 });
        var moved = Core.moveCurrentNode(root, one, Core.RIGHT);
        if (!moved || moved.result !== Core.MOVE_DONE) {
            bad.push("moveCurrentNode returned " + JSON.stringify(moved && moved.result));
        }
        Core.convertToStack(two.data);
        if (Core.handleStackMove(two.data, Core.UP).result !== Core.STACK_DEFAULT) {
            bad.push("handleStackMove on a stack of one should decline");
        }
        if (!Core.hasFloatingException(Core.compileExceptions(Core.DEFAULT_EXCEPTIONS, null), "krunner", "")) {
            bad.push("the tiling exceptions did not compile");
        }

        if (bad.length) {
            console.log("QML LOAD FAILED: " + bad.join("; "));
            Qt.exit(1);
        } else {
            console.log("qml load ok");
            Qt.exit(0);
        }
    }
}
