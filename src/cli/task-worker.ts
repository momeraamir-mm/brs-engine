/*---------------------------------------------------------------------------------------------
 *  BrightScript Engine (https://github.com/lvcabral/brs-engine)
 *
 *  Copyright (c) 2019-2026 Marcelo Lv Cabral. All Rights Reserved.
 *
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/
//
// Node task worker entry: runs a SceneGraph Task's function on its own worker_thread.
// The browser path (api/task.ts + the #if BROWSER onmessage handler) spawns a Web Worker;
// this is the Node worker_threads equivalent. It registers the SceneGraph extension the
// Node way (require, like the CLI main thread does) since loadExtension() only supports
// the browser importScripts() path, then runs executeTask on the received TaskPayload.
//
import path from "node:path";
import { parentPort } from "node:worker_threads";
import { isTaskPayload } from "../core/common";
// @ts-ignore
import * as brs from "./brs.node.js";

declare const __non_webpack_require__: NodeJS.Require;
const loadModule = typeof __non_webpack_require__ === "function" ? __non_webpack_require__ : eval("require");

if (parentPort) {
    const port = parentPort;
    // Route the engine's outbound messages to the parent (main) thread.
    globalThis.postMessage = (message: any) => port.postMessage(message);

    // Load the SceneGraph extension in this worker (Node require, mirrors loadSceneGraphExtension).
    try {
        const sg = loadModule(path.join(__dirname, "brs-sg.node.js"));
        brs.registerExtension(() => new sg.BrightScriptExtension());
    } catch (err: any) {
        port.postMessage(`warning,[task-worker] Failed to load SceneGraph extension: ${err.message}`);
    }

    port.on("message", (data: any) => {
        if (data instanceof SharedArrayBuffer) {
            brs.BrsDevice.setSharedArray(new Int32Array(data));
        } else if (isTaskPayload(data)) {
            try {
                brs.executeTask(data);
            } catch (err: any) {
                port.postMessage(`error,[task-worker] executeTask failed: ${err.message}`);
            }
        }
    });
}
