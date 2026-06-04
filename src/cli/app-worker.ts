#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  BrightScript Engine (https://github.com/lvcabral/brs-engine)
 *
 *  Copyright (c) 2019-2026 Marcelo Lv Cabral. All Rights Reserved.
 *
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/
//
// Node engine worker entry: runs the whole BrightScript app (executeFile) on its own
// worker_thread, mirroring the browser path (the #if BROWSER `onmessage` handler in
// core/index.ts runs executeFile inside a Web Worker). Keeping the engine off the CLI's
// main thread is what lets the main thread stay free to spawn SceneGraph Task workers on
// demand (see handleTaskData in cli/index.ts); when the engine ran on the main thread its
// infinite render loop starved the event loop and Task workers could never boot.
//
import path from "node:path";
import { parentPort } from "node:worker_threads";
import { isAppPayload } from "../core/common";
// @ts-ignore
import * as brs from "./brs.node.js";

declare const __non_webpack_require__: NodeJS.Require;
const loadModule = typeof __non_webpack_require__ === "function" ? __non_webpack_require__ : eval("require");

if (parentPort) {
    const port = parentPort;
    // Route the engine's outbound messages to the parent (main) thread.
    // Rendered frames come through as node-canvas ImageData; its prototype does NOT survive
    // structuredClone, so the main thread's `instanceof ImageData` check would drop every
    // frame. Normalize frames to a tagged { image } payload and transfer the pixel buffer
    // (zero-copy) so the main thread can rebuild the ImageData for screenshot/ascii output.
    globalThis.postMessage = (message: any) => {
        if (
            message &&
            typeof message === "object" &&
            typeof message.width === "number" &&
            typeof message.height === "number" &&
            message.data?.buffer instanceof ArrayBuffer
        ) {
            const buffer = message.data.buffer;
            port.postMessage({ image: { width: message.width, height: message.height, data: buffer } }, [buffer]);
        } else {
            port.postMessage(message);
        }
    };

    // Load the SceneGraph extension in this worker (Node require, mirrors loadSceneGraphExtension).
    try {
        const sg = loadModule(path.join(__dirname, "brs-sg.node.js"));
        brs.registerExtension(() => new sg.BrightScriptExtension());
    } catch (err: any) {
        port.postMessage(`warning,[app-worker] Failed to load SceneGraph extension: ${err.message}`);
    }

    port.on("message", (data: any) => {
        if (data instanceof SharedArrayBuffer) {
            brs.BrsDevice.setSharedArray(new Int32Array(data));
        } else if (isAppPayload(data)) {
            brs.executeFile(data, {}, true)
                .then((result: any) => port.postMessage({ appExit: result?.exitReason }))
                .catch((err: any) => port.postMessage(`error,[app-worker] ${err.message}`));
        }
    });
}
