// SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-only

// Does KWin's JavaScript engine accept this code at all?
//
// The simulators run in Node, and Node is a far more forgiving engine than the one a KWin script
// actually runs in. QJSEngine is Qt's V4, which stops at roughly ES7: object spread in a literal
// is a syntax error there and ordinary JavaScript everywhere else, so a `{ ...geo }` passes 29
// sims and then fails to load in the session. That is a whole logout to find out, which is why
// this exists.
//
// It loads the modules exactly as contents/ui/main.qml does -- a QML `import ... as` of each .mjs,
// which is the same parse KWin performs -- and touches a value from each so the import cannot be
// optimised away. It does not run the tiler: there is no KWin API here. It answers one question,
// which is whether the files parse.
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

        // A few shapes the engine has to support at run time, not only parse.
        var g = Core.newGroup(Core.VERTICAL, { x: 0, y: 0, w: 100, h: 100 });
        var n = Core.node(g);
        Core.appendChild(n, Core.node(Core.newMapped("a")));
        Core.appendChild(n, Core.node(Core.newMapped("b")));
        Core.addWindow(n.data, 1);
        var out = Core.measure(n, { x: 0, y: 0, w: 1000, h: 800 }, { outer: 0, inner: 8 });
        if (!out || !out.configures || out.configures.length !== 2) {
            bad.push("measure returned " + JSON.stringify(out && out.configures));
        }

        // QJSEngine warns that moveCurrentNode reads STACK_HANDLED hundreds of lines before the
        // const that declares it. In a module that is safe -- the whole file is evaluated before
        // any function of it is called -- but "safe in theory" is what the last bug was, so the
        // path is actually walked here. A temporal-dead-zone error would land on a keypress.
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
