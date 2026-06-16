#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  BrightScript Engine (https://github.com/lvcabral/brs-engine)
 *
 *  Copyright (c) 2019-2026 Marcelo Lv Cabral. All Rights Reserved.
 *
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import readline from "node:readline";
import { Worker } from "node:worker_threads";
import { gateway4sync } from "default-gateway";
import envPaths from "env-paths";
import { ImageData, createCanvas } from "canvas";
import chalk from "chalk";
import { Command } from "commander";
import stripAnsi from "strip-ansi";
import { deviceData, loadAppZip, updateAppZip, subscribePackage, mountExt, setupDeepLink, createPayload } from "./package";
import { runAnalyze } from "./analyze";
import { deriveMaxColumns, renderAsciiFrame, renderUnicodeFrame, printFrame, frameToPngBuffer } from "./display";
import { isNumber } from "../api/util";
import {
    DebugPrompt,
    DataBufferIndex,
    DataBufferSize,
    AppPayload,
    AppExitReason,
    AppData,
    SupportedExtension,
    isRegistryData,
    isTaskData,
    isThreadUpdate,
    MediaEvent,
    TaskData,
    TaskState,
    TaskPayload,
    ThreadUpdate,
    ExtensionInfo,
    DataType,
    ExtVolInitialSize,
    ExtVolMaxSize,
} from "../core/common";
import SharedObject from "../core/SharedObject";
import packageInfo from "../../packages/node/package.json";
// @ts-ignore
import * as brs from "./brs.node.js";

// Constants
declare const __non_webpack_require__: NodeJS.Require;
const loadModule = typeof __non_webpack_require__ === "function" ? __non_webpack_require__ : eval("require");
const program = new Command();
const paths = envPaths("brs", { suffix: "cli" });
const defaultLevel = chalk.level;
const maxColumns = deriveMaxColumns();
const length = DataBufferIndex + DataBufferSize;
const BrsDevice = brs.BrsDevice;

// Variables
let appFileName = "";
let lastScreenshotMs = 0;
let currentPayload: AppPayload;
const MAX_TASKS = 10;
const taskWorkers = new Map<number, Worker>();
// SharedObject rendezvous channels bridging the engine worker and each Task worker.
// A worker blocked in a synchronous field rendezvous (Atomics.wait) cannot receive
// postMessage, so the main thread relays updates by writing into the SharedObject the
// target worker is waiting on (mirrors the browser api/task.ts relay).
const threadSyncToTask = new Map<number, SharedObject>();
const threadSyncToMain = new Map<number, SharedObject>();
const extensions: ExtensionInfo[] = [];
let brsWorker: Worker;
let appWorker: Worker;
let workerReady = false;
let sharedBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * length);
let sharedArray = new Int32Array(sharedBuffer);
sharedArray.fill(-1);
// Launch request channel (ECP worker -> main), separate from the control buffer.
// The ECP worker writes the deep-link params here and sets an Atomics flag; the main
// thread checks it per render frame (see messageCallback), so a deep-link launch lands
// even while the app floods the main thread with frames during playback — a postMessage
// relay gets starved there, but a per-frame Atomics check does not. Layout: [0]=flag,
// [1]=JSON char length, [2..]=JSON char codes. Zero-initialized (flag idle = 0).
const LAUNCH_BUF_LEN = 258;
const launchBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * LAUNCH_BUF_LEN);
const launchArray = new Int32Array(launchBuffer);
// True while a deep-link relaunch is tearing down the old worker and spawning the new one.
// Guards against starting a second relaunch (and a second node-canvas renderer) mid-teardown.
let relaunching = false;

/**
 * CLI program, params definition and action processing.
 *
 */
program
    .description(`${packageInfo.title} CLI`)
    .arguments(`brs-cli [brsFiles...]`)
    .option("-a, --ascii <columns>", "Enable ASCII screen mode with # of columns.")
    .option("-u, --unicode", "Render ASCII screen mode using Unicode block characters.", false)
    .option("-s, --screenshot <file>", "Continuously write the latest rendered frame as a PNG to <file> (headless capture).")
    .option("-c, --colors <level>", "Define the console color level (0 to disable).", defaultLevel)
    .option("-d, --debug", "Open the micro debugger if the app crashes.", false)
    .option("-e, --ecp", "Enable the ECP server for control simulation.", false)
    .option("-n, --no-sg", "Disable the SceneGraph extension.")
    .option("-p, --pack <password>", "The password to generate the encrypted package.", "")
    .option("-o, --out <directory>", "The directory to save the encrypted package file.", "./")
    .option("-r, --root <directory>", "The root directory from which `pkg:` paths will be resolved.")
    .option("-x, --ext-vol <path>", "Path to directory or zip file from which `ext1:` will be mounted.")
    .option("-k, --deep-link <params>", "Parameters to be passed to the application. (format: key=value,...)")
    .option("-y, --registry", "Persist the simulated device registry on disk.", false)
    .option("--analyze", "Run the Store-Analysis / certification preflight on the package and exit.", false)
    .option("--prev <version>", "Published version to diff against for the bump check (use with --analyze).")
    .option("--verbose", "Show engine debug-level log messages (Task/SceneGraph internals).", false)
    .action(async (brsFiles, program) => {
        if (program.analyze) {
            process.exit(runAnalyze(brsFiles[0], { prev: program.prev }));
        }
        if (!checkParameters()) {
            return;
        }
        if (typeof deviceData === "object") {
            deviceData.customFeatures.push("ascii_rendering");
            deviceData.assets = fs.readFileSync(path.join(__dirname, "../assets/common.zip"))?.buffer;
            deviceData.localIps = getLocalIps();
            try {
                const { gateway, int } = gateway4sync();
                deviceData.connectionInfo.gateway = gateway;
                deviceData.connectionInfo.name = int ?? "eth1";
            } catch (err: any) {
                // Non-fatal: the gateway is unused headless, and default-gateway shells out to
                // wmic (removed in Windows 11). Only surface it in verbose mode to avoid noise.
                if (program.verbose) {
                    console.warn(chalk.yellow(`Network gateway unavailable: ${err.message}`));
                }
            }
            deviceData.connectionInfo.dns = dns.getServers();
            deviceData.debugOnCrash = program.debug ?? false;
            if (program.registry) {
                deviceData.registry = getRegistry();
            }
            deviceData.appList = new Array<AppData>();
        }
        if (program.sg) {
            await loadSceneGraphExtension();
        }
        subscribePackage("cli", packageCallback);
        brs.registerCallback(messageCallback, sharedBuffer);
        if (brsFiles.length > 0) {
            await runAppFiles(brsFiles);
        } else {
            displayTitle();
            repl();
        }
    })
    .version(packageInfo.version, "-v, --version")
    .parse(process.argv);

/**
 * Validates and normalizes CLI parameters.
 * Sets default values for color level, ASCII mode, and validates file paths.
 * @returns True if all parameters are valid, false otherwise
 */
function checkParameters() {
    if (isNumber(program.colors) && program.colors >= 0 && program.colors <= 3) {
        chalk.level = Math.trunc(program.colors) as chalk.Level;
    } else {
        console.warn(chalk.yellow(`Invalid color level! Valid range is 0-3, keeping default: ${defaultLevel}.`));
    }
    if (program.ascii) {
        if (isNumber(program.ascii)) {
            program.ascii = +program.ascii;
        } else {
            program.ascii = 0;
        }
        if (program.ascii < 32) {
            program.ascii = maxColumns;
            console.warn(
                chalk.yellow(`Invalid # of columns! Valid values are >=32, using current width: ${program.ascii}.`)
            );
        }
    } else if (program.unicode) {
        program.ascii = maxColumns;
    }
    if (program.root && !fs.existsSync(program.root)) {
        console.error(chalk.red(`Root path not found: ${program.root}\n`));
        process.exitCode = 1;
        return;
    }
    if (program.extVol && !fs.existsSync(program.extVol)) {
        console.error(chalk.red(`External storage path not found: ${program.extVol}\n`));
        process.exitCode = 1;
        return;
    }
    return process.exitCode !== 1;
}

/**
 * Dynamically load the SceneGraph extension module.
 */
async function loadSceneGraphExtension() {
    try {
        const sgLib = "brs-sg.node.js";
        const sg = await loadModule(path.join(__dirname, sgLib));
        const extension = new sg.BrightScriptExtension();
        brs.registerExtension(() => extension);
        extensions.push({ name: SupportedExtension.SceneGraph, library: sgLib, version: extension.version });
        deviceData.extensions = new Map([[SupportedExtension.SceneGraph, sgLib]]);
    } catch (err: any) {
        console.error(chalk.red(`Error loading SceneGraph extension: ${err.message}`));
    }
}

/**
 * Executes BrightScript files or application packages (.zip/.bpk).
 * Handles package creation if password is provided, otherwise runs the app.
 * @param files - Array of file paths to execute (first file is used)
 */
async function runAppFiles(files: string[]) {
    try {
        const filePath = files[0];
        const fileName = filePath.split(/.*[/|\\]/)[1] ?? filePath;
        const fileExt = fileName.split(".").pop()?.toLowerCase();
        appFileName = fileName;
        if (fileExt === "zip" || fileExt === "bpk") {
            // Run App Package file
            displayTitle();
            if (program.pack.length > 0 && fileExt === "zip") {
                console.log(chalk.blueBright(`Packaging ${filePath}...\n`));
            } else {
                console.log(chalk.blueBright(`Executing ${filePath}...\n`));
                if (program.extVol?.endsWith(".zip")) {
                    mountExt(new Uint8Array(fs.readFileSync(program.extVol)).buffer);
                }
                setupDeepLink(processDeepLink());
            }
            const fileData = new Uint8Array(fs.readFileSync(filePath)).buffer;
            deviceData.entryPoint = true;
            loadAppZip(fileName, fileData, runApp);
            return;
        }
        // Run BrightScript files
        deviceData.appList?.push({ id: "dev", title: fileName, version: "1.0.0" });
        const payload = await brs.createPayloadFromFiles(
            files,
            deviceData,
            processDeepLink(),
            program.root,
            program.extVol
        );
        runApp(payload);
    } catch (err: any) {
        if (err.messages?.length) {
            for (const message of err.messages) {
                console.error(chalk.red(message));
            }
        } else {
            console.error(chalk.red(err.message));
        }
        process.exitCode = 1;
    }
}

/**
 * Parses deep link parameters from command line arguments.
 * Expects format: key=value,key2=value2
 * @returns Map containing the deep link key-value pairs
 */
function processDeepLink() {
    const deepLinkMap: Map<string, string> = new Map();
    const deepLinkParams = program.deepLink?.split(",");
    if (deepLinkParams) {
        for (const value of deepLinkParams) {
            if (value?.includes("=")) {
                const [key, val] = value.split("=");
                deepLinkMap.set(key, val);
            } else {
                console.warn(chalk.yellow(`Invalid deep link parameter: ${value}`));
            }
        }
    }
    return deepLinkMap;
}

/**
 * Displays the CLI application title and version on the console.
 * Shows dev indicator in debug builds.
 */
function displayTitle() {
    const appTitle = `${packageInfo.title} CLI`;
    const appVersion = `v${packageInfo.version}`;
    /// #if DEBUG
    console.log(`\n${appTitle} [${chalk.cyanBright(appVersion)} ${chalk.gray("dev")}]\n`);
    /// #else
    console.log(`\n${appTitle} [${chalk.cyanBright(appVersion)}]\n`);
    /// #endif
}

/**
 * Executes the application payload or generates an encrypted package.
 * Initializes ECP worker if enabled, then runs the app or creates .bpk file.
 * @param payload - The application payload containing code, device info, and options
 */
async function runApp(payload: AppPayload) {
    payload.password = program.pack;
    currentPayload = payload;
    const packaging = program.pack.length > 0;
    if (program.ecp && !workerReady && !packaging) {
        // Load ECP service as Worker
        const workerPath = path.join(__dirname, "brs.ecp.js");
        const workerData = { device: payload.device };
        brsWorker = new Worker(workerPath, { workerData: workerData });
        brsWorker.once("message", (value: any) => {
            if (value?.ready) {
                console.log(chalk.blueBright(value?.msg));
                workerReady = true;
                runApp(payload);
            } else {
                brsWorker?.terminate();
                console.error(chalk.red(value?.msg));
                process.exitCode = 1;
            }
        });
        brsWorker.postMessage({ launch: launchBuffer });
        brsWorker.postMessage(sharedBuffer);
        return;
    }
    if (!packaging) {
        // Run the engine on its own worker thread (mirrors the browser model) so the CLI
        // main thread stays free to spawn SceneGraph Task workers on demand. Running the
        // engine on the main thread starves the event loop (infinite render loop) and Task
        // workers never boot. The app's exit is reported back via an { appExit } message.
        spawnAppWorker(payload);
        return;
    }
    try {
        const pkg = await brs.executeFile(payload, {}, true);
        if (pkg.exitReason === AppExitReason.Packaged) {
            // Generate the Encrypted App Package
            const filePath = path.join(program.out, appFileName.replaceAll(/.zip/gi, ".bpk"));
            try {
                const buffer = updateAppZip(pkg.cipherText, pkg.iv);
                fs.writeFileSync(filePath, buffer);
                console.log(
                    chalk.blueBright(
                        `Package file created as ${filePath} with ${Math.round(buffer.length / 1024)} KB.\n`
                    )
                );
            } catch (err: any) {
                console.error(chalk.red(`Error generating the file ${filePath}: ${err.message}`));
                process.exitCode = 1;
            }
        } else {
            const msg = `------ Finished '${appFileName}' execution [${pkg.exitReason}] ------\n`;
            if (pkg.exitReason === AppExitReason.UserNav) {
                console.log(chalk.blueBright(msg));
            } else {
                process.exitCode = 1;
                console.log(chalk.redBright(msg));
            }
        }
    } catch (err: any) {
        console.error(chalk.red(`Error executing app: ${err.message}`));
        process.exitCode = 1;
    }
}

/**
 * Spawns the engine app worker for the given payload and wires its message/error channels.
 * Factored out of runApp so a deep-link launch can relaunch the app the same way.
 * @param payload - The application payload to execute in the worker.
 */
function spawnAppWorker(payload: AppPayload) {
    try {
        const worker = new Worker(path.join(__dirname, "brs.app.js"));
        appWorker = worker;
        worker.on("message", (msg: any) => messageCallback(msg));
        worker.on("error", (err: any) => {
            console.error(chalk.red(`Error executing app: ${err.message}`));
            process.exitCode = 1;
        });
        worker.postMessage(sharedBuffer);
        worker.postMessage(payload);
    } catch (err: any) {
        console.error(chalk.red(`Error executing app: ${err.message}`));
        process.exitCode = 1;
    }
}

/**
 * Drains a pending deep-link launch request written by the ECP worker into the launch
 * buffer (Atomics flag at [0]). Called per render frame from messageCallback, so it fires
 * even while playback floods the main thread — the reason the request rides the shared
 * buffer instead of a (starvable) postMessage relay.
 */
function checkLaunchRequest() {
    if (Atomics.load(launchArray, 0) !== 1) {
        return;
    }
    if (relaunching) {
        // A relaunch is still tearing down; leave the request flag set and retry next frame.
        return;
    }
    const len = Atomics.load(launchArray, 1);
    let json = "";
    for (let i = 0; i < len; i++) {
        json += String.fromCharCode(Atomics.load(launchArray, 2 + i));
    }
    Atomics.store(launchArray, 0, 0); // consume the request
    try {
        relaunchApp(JSON.parse(json)).catch((err: any) =>
            console.error(chalk.red(`Relaunch failed: ${err.message}`))
        );
    } catch (err: any) {
        console.error(chalk.red(`Invalid deep-link launch request: ${err.message}`));
    }
}

/**
 * Relaunches the running app with deep-link parameters (ECP POST /launch/<appID>).
 * Mirrors a real device cold-start deep link: the engine worker is torn down and respawned
 * so Main(args) is re-entered with the contentId/mediaType, exercising the Direct-to-Play
 * path that certification requires. The ECP worker and process stay alive across the relaunch.
 * @param params - Deep-link key/value parameters (e.g. { contentId, mediaType }).
 */
async function relaunchApp(params: Record<string, string>) {
    if (!currentPayload || program.pack.length > 0 || relaunching) {
        return;
    }
    relaunching = true;
    try {
        const deepLink = new Map<string, string>();
        for (const [key, value] of Object.entries(params ?? {})) {
            if (value !== undefined && value !== null && key !== "source_ip_addr") {
                deepLink.set(key, String(value));
            }
        }
        setupDeepLink(deepLink, "external-control");
        currentPayload = createPayload(Date.now());
        // Tear down the current engine + Task workers (keep the ECP worker + process alive).
        // Await full termination BEFORE respawning: Worker.terminate() is asynchronous, and
        // node-canvas/Cairo holds process-global render/font state — letting the old worker
        // keep rendering while the new one starts races in the native layer and intermittently
        // aborts the process (the flaky doDrawRotatedText crash). Awaiting serialises them.
        const dying: Promise<number>[] = [];
        if (appWorker) {
            dying.push(appWorker.terminate());
        }
        for (const worker of taskWorkers.values()) {
            dying.push(worker.terminate());
        }
        taskWorkers.clear();
        threadSyncToTask.clear();
        threadSyncToMain.clear();
        await Promise.all(dying);
        console.log(chalk.blueBright(`Relaunching '${appFileName}' via deep link...\n`));
        spawnAppWorker(currentPayload);
    } finally {
        relaunching = false;
    }
}

/**
 * Retrieves all local IPv4 addresses from network interfaces.
 * Excludes internal (127.0.0.1) addresses and handles multiple IPs per interface.
 * @returns Array of strings in format "interface,ip" or "interface:alias,ip"
 */
function getLocalIps() {
    const ifaces = os.networkInterfaces();
    const ips = new Array<string>();
    for (const ifname of Object.keys(ifaces)) {
        let alias = 0;
        const ifaceList = ifaces[ifname];
        if (ifaceList) {
            for (const iface of ifaceList) {
                if ("IPv4" !== iface.family || iface.internal !== false) {
                    // skip over internal (i.e. 127.0.0.1) and non-ipv4 addresses
                    continue;
                }
                if (alias >= 1) {
                    // this single interface has multiple ipv4 addresses
                    ips.push(`${ifname}:${alias},${iface.address}`);
                } else {
                    // this interface has only one ipv4 address
                    ips.push(`${ifname},${iface.address}`);
                }
                ++alias;
            }
        }
    }
    return ips;
}

/**
 * Loads persisted registry data from disk.
 * Filters out transient entries (keys with .Transient section).
 * @returns Map containing the persisted registry key-value pairs
 */
function getRegistry(): Map<string, string> {
    let registry = new Map<string, string>();
    try {
        const strRegistry = fs.readFileSync(path.resolve(paths.data, "registry.json"));
        if (strRegistry?.length) {
            const parsed = JSON.parse(strRegistry.toString("utf8"));
            if (typeof parsed === "object" && parsed !== null) {
                for (const [key, value] of new Map(parsed)) {
                    if (typeof key === "string" && typeof value === "string" && key.split(".")[1] !== "Transient") {
                        registry.set(key, value);
                    }
                }
            }
        }
    } catch (err: any) {
        console.error(chalk.red(err.message));
    }
    return registry;
}

/**
 * Launches an interactive read-execute-print loop (REPL).
 * Reads input from stdin and executes BrightScript expressions.
 */
async function repl() {
    const payload: Partial<AppPayload> = {
        device: deviceData,
        root: program.root,
    };
    // Load the external storage if provided
    let extPath = "";
    if (program.extVol && fs.existsSync(program.extVol)) {
        if (fs.statSync(program.extVol).isDirectory()) {
            payload.ext = program.extVol;
            extPath = program.extVol;
        } else if (program.extVol.endsWith(".zip")) {
            const extObj = new SharedObject(ExtVolInitialSize, ExtVolMaxSize);
            extObj.storeData(new Uint8Array(fs.readFileSync(program.extVol)).buffer);
            payload.extZip = extObj.getBuffer();
            extPath = program.extVol;
            Atomics.store(sharedArray, DataType.EVE, 1);
        }
    }
    const replInterpreter = brs.getReplInterpreter(payload);
    if (!replInterpreter) {
        return;
    }
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    rl.setPrompt(`\n${chalk.magenta("brs")}> `);
    rl.on("line", async (line) => {
        if (["exit", "quit", "q"].includes(line.toLowerCase().trim())) {
            process.exit();
        } else if (["cls", "clear"].includes(line.toLowerCase().trim())) {
            process.stdout.write("\x1Bc");
        } else if (["help", "hint"].includes(line.toLowerCase().trim())) {
            printHelp();
        } else if (["vol", "vols"].includes(line.toLowerCase().trim())) {
            const vols = BrsDevice.fileSystem.volumesSync();
            process.stdout.write(chalk.cyanBright(`\nMounted volumes:\n\n`));
            const rootPath = payload.root ?? "not mounted";
            process.stdout.write(chalk.cyanBright(`pkg:      ${rootPath}\n`));
            const extMounted = vols.includes("ext1:");
            process.stdout.write(chalk.cyanBright(`ext1:     ${extMounted ? extPath : "not mounted"}\n`));
            process.stdout.write(chalk.cyanBright(`tmp:      [In Memory]\n`));
            process.stdout.write(chalk.cyanBright(`cachefs:  [In Memory]\n`));
            process.stdout.write(chalk.cyanBright(`common:   [Read Only]\n`));
        } else if (["var", "vars"].includes(line.split(" ")[0]?.toLowerCase().trim())) {
            const scopeName = line.split(" ")[1]?.toLowerCase().trim() ?? "function";
            listVariables(scopeName, replInterpreter);
        } else if (["xt", "ext"].includes(line.toLowerCase().trim())) {
            process.stdout.write(chalk.cyanBright(`\nLoaded Extensions:\n\n`));
            if (extensions.length) {
                for (const { name, library, version } of extensions) {
                    process.stdout.write(chalk.cyanBright(`${name}: ${library} (v${version})\n`));
                }
            } else {
                process.stdout.write(chalk.yellowBright("No extensions loaded.\n"));
            }
        } else if (["umt", "umount"].includes(line.toLowerCase().trim())) {
            if (BrsDevice.fileSystem.volumesSync().includes("ext1:")) {
                BrsDevice.umountExtVolume();
                Atomics.store(sharedArray, DataType.EVE, 0);
                process.stdout.write(chalk.greenBright(`\next1: volume unmounted successfully.\n`));
                extPath = "";
            } else {
                process.stdout.write(chalk.yellowBright(`\next1: volume is not mounted.\n`));
            }
        } else if (["mnt", "mount"].includes(line.toLowerCase().trim().split(" ")[0])) {
            const mountPath = line.toLowerCase().trim().split(" ")[1] ?? "";
            if (mountExtVolume(mountPath)) {
                Atomics.store(sharedArray, DataType.EVE, 1);
                extPath = mountPath;
            }
        } else {
            brs.executeLine(line, replInterpreter);
        }
        rl.prompt();
    });
    process.stdout.write(colorize("type `help` to see the list of valid REPL commands.\n"));
    rl.prompt();
}

/**
 * Lists variables in the specified scope from the interpreter.
 * @param scopeName The scope to list variables from: global, module, or function
 * @param interpreter The BrightScript interpreter instance
 */
function listVariables(scopeName: string, interpreter: brs.Interpreter) {
    let scope = 2; // Function scope
    if (scopeName === "global") {
        scope = 0; // Global scope
        process.stdout.write(chalk.cyanBright(`\nGlobal variables:\n\n`));
    } else if (scopeName === "module") {
        scope = 1; // Module scope
        process.stdout.write(chalk.cyanBright(`\nModule variables:\n\n`));
    } else {
        process.stdout.write(chalk.cyanBright(`\nLocal variables:\n\n`));
    }
    const variables = interpreter.formatVariables(scope).trimEnd();
    process.stdout.write(chalk.cyanBright(variables));
    process.stdout.write("\n");
}

/**
 * Mounts the ext1: volume from a directory or zip file.
 * @param mountPath The path to the directory or zip file to mount
 * @returns True if the volume was mounted successfully, false otherwise
 */
function mountExtVolume(mountPath: string) {
    if (BrsDevice.fileSystem.volumesSync().includes("ext1:")) {
        process.stdout.write(chalk.yellowBright(`\next1: volume is already mounted.\n`));
        return false;
    }
    if (!fs.existsSync(mountPath)) {
        process.stdout.write(chalk.redBright(`\nPath to mount ext1: volume not found: "${mountPath}"\n`));
    } else if (mountPath.toLowerCase().endsWith(".zip")) {
        const extZip = new Uint8Array(fs.readFileSync(mountPath)).buffer;
        if (BrsDevice.mountExtVolume(extZip)) {
            process.stdout.write(chalk.greenBright(`\next1: volume mounted successfully from file.\n`));
            return true;
        } else {
            process.stdout.write(chalk.redBright(`\nFailed to mount ext1: volume from file.\n`));
        }
    } else {
        BrsDevice.mountExtPathVolume(mountPath);
        process.stdout.write(chalk.greenBright(`\next1: volume mounted successfully from directory.\n`));
        return true;
    }
    return false;
}

/**
 * Callback function for receiving messages from the packager.
 * Handles error and warning events by displaying them with appropriate colors.
 * @param event - The event type (error, warning, etc.)
 * @param data - The message data to display
 */
function packageCallback(event: string, data: any) {
    if (["error", "warning"].includes(event)) {
        if (event === "error") {
            console.error(chalk.red(data));
        } else {
            console.warn(chalk.yellow(data));
        }
    } else if (event === "mount") {
        Atomics.store(sharedArray, DataType.EVE, data);
    } else if (event === "debug") {
        console.debug(chalk.gray(data));
    }
}

/**
 * Callback function for receiving messages from the interpreter.
 * Handles string messages, ImageData for ASCII rendering, and registry Map for persistence.
 * @param message - The message from interpreter (string, ImageData, or Map)
 * @param _ - Unused parameter
 */
/**
 * Writes the latest rendered frame to a PNG file for headless visual capture.
 * Throttled to at most once per 250ms to avoid excessive disk I/O at render cadence.
 * @param frame - The ImageData frame received from the engine
 * @param file - Destination PNG path (from the --screenshot option)
 */
function saveScreenshot(frame: ImageData, file: string) {
    const now = Date.now();
    if (now - lastScreenshotMs < 250) {
        return;
    }
    lastScreenshotMs = now;
    try {
        fs.writeFileSync(file, frameToPngBuffer(frame));
    } catch (err: any) {
        console.error(chalk.red(`[screenshot] write failed: ${err.message}`));
    }
}

/**
 * Starts or stops a SceneGraph Task on its own Node worker_thread in response to a
 * TaskData message from the engine worker. Mirrors the browser api/task.ts handleTaskData().
 * @param taskData Task metadata posted by the engine when control becomes run/stop.
 */
function handleTaskData(taskData: TaskData) {
    if (taskData.state === TaskState.RUN) {
        if (taskData.buffer instanceof SharedArrayBuffer) {
            // The engine created this "to-main" channel; wrap it so the main thread can
            // deliver task-originated field updates to the engine worker waiting on it.
            const taskBuffer = new SharedObject();
            taskBuffer.setBuffer(taskData.buffer);
            threadSyncToMain.set(taskData.id, taskBuffer);
        }
        runTask(taskData);
    } else if (taskData.state === TaskState.STOP) {
        endTask(taskData.id);
    }
}

/**
 * Spawns a Node worker_thread to run a Task's function, wiring its "to-task" rendezvous
 * channel. Mirrors the browser api/task.ts runTask().
 * @param taskData Task configuration (carries the function name and sync buffer).
 */
function runTask(taskData: TaskData) {
    if (taskWorkers.has(taskData.id) || !taskData.m?.top?.functionname || !currentPayload) {
        return;
    } else if (taskWorkers.size >= MAX_TASKS) {
        console.warn(chalk.yellow(`[task] Maximum number of tasks reached: ${taskWorkers.size}`));
        return;
    }
    const worker = new Worker(path.join(__dirname, "brs.task.js"));
    worker.on("message", (msg: any) => taskCallback(msg));
    worker.on("error", (err: any) => console.error(chalk.red(`[task] worker error: ${err.message}`)));
    taskWorkers.set(taskData.id, worker);
    if (!threadSyncToTask.has(taskData.id)) {
        threadSyncToTask.set(taskData.id, new SharedObject());
    }
    taskData.buffer = threadSyncToTask.get(taskData.id)?.getBuffer();
    const taskPayload: TaskPayload = {
        device: currentPayload.device,
        manifest: currentPayload.manifest,
        taskData: taskData,
        extensions: currentPayload.extensions,
        paths: currentPayload.paths,
        pkgZip: currentPayload.pkgZip,
        extZip: currentPayload.extZip,
    };
    worker.postMessage(sharedBuffer);
    worker.postMessage(taskPayload);
}

/**
 * Terminates a running Task worker and clears its rendezvous channels.
 * @param taskId Id of the Task to terminate.
 */
function endTask(taskId: number) {
    const worker = taskWorkers.get(taskId);
    if (worker) {
        worker.terminate();
        taskWorkers.delete(taskId);
        threadSyncToTask.delete(taskId);
        threadSyncToMain.delete(taskId);
    }
}

/**
 * Relays a field-sync ThreadUpdate between the engine worker and Task workers by writing it
 * into the SharedObject the target worker is blocked on. Mirrors browser api/task.ts.
 * @param threadUpdate The field update to relay.
 * @param fromTask True when the update originated from a Task worker (vs the engine worker).
 */
function handleThreadUpdate(threadUpdate: ThreadUpdate, fromTask: boolean = false) {
    if (fromTask) {
        threadSyncToMain.get(threadUpdate.id)?.waitStore(threadUpdate, 1);
    }
    if (threadUpdate.id > 0 && !fromTask) {
        updateTask(threadUpdate.id, threadUpdate);
    } else if (threadUpdate.type !== "task") {
        // Propagate to other tasks
        for (const taskId of taskWorkers.keys()) {
            if (!fromTask || (taskId !== threadUpdate.id && threadUpdate.action === "set")) {
                updateTask(taskId, threadUpdate);
            }
        }
    }
}

/**
 * Writes a ThreadUpdate into a Task's "to-task" rendezvous channel.
 * @param targetId Id of the target Task worker.
 * @param data The field update to deliver.
 */
function updateTask(targetId: number, data: ThreadUpdate) {
    if (!threadSyncToTask.has(targetId)) {
        threadSyncToTask.set(targetId, new SharedObject());
    }
    threadSyncToTask.get(targetId)?.waitStore(data, 1);
}

/**
 * Handles messages emitted by a Task worker (mirrors browser api/task.ts taskCallback).
 * @param message The message posted by the Task worker.
 */
function taskCallback(message: any) {
    if (isRegistryData(message)) {
        handleRegistryData(message);
    } else if (isThreadUpdate(message)) {
        handleThreadUpdate(message, true);
    } else if (isTaskData(message) && message.state === TaskState.STOP) {
        endTask(message.id);
    } else if (typeof message === "string") {
        handleStringMessage(message);
    }
}

function messageCallback(message: any, _?: any) {
    checkLaunchRequest();
    if (typeof message === "string") {
        handleStringMessage(message);
    } else if (message instanceof ImageData) {
        renderFrame(message);
    } else if (message?.image?.data instanceof ArrayBuffer) {
        // Frame relayed from the engine worker (see app-worker.ts): rebuild the ImageData
        // that structuredClone stripped of its prototype on the way across the thread.
        const { width, height, data } = message.image;
        renderFrame(new ImageData(new Uint8ClampedArray(data), width, height));
    } else if (typeof message?.appExit === "string") {
        finalizeRun(message.appExit);
    } else if (isTaskData(message)) {
        handleTaskData(message);
    } else if (isThreadUpdate(message)) {
        handleThreadUpdate(message, false);
    } else if (isRegistryData(message)) {
        handleRegistryData(message);
    }
}

/**
 * Routes registry telemetry from the engine/task workers to the ECP service and disk.
 * @param message Registry data message containing the current registry map.
 */
function handleRegistryData(message: any) {
    if (program.ecp) {
        brsWorker?.postMessage(message.current);
    }
    if (program.registry) {
        const strRegistry = JSON.stringify([...message.current]);
        try {
            if (!fs.existsSync(paths.data)) {
                fs.mkdirSync(paths.data, { recursive: true });
            }
            fs.writeFileSync(path.resolve(paths.data, "registry.json"), strRegistry);
        } catch (err: any) {
            console.error(chalk.red(err.message));
        }
    }
}

/**
 * Renders a frame emitted by the engine: writes the screenshot PNG and/or the ASCII frame.
 * @param frame - The rendered ImageData for the current display buffer.
 */
function renderFrame(frame: ImageData) {
    if (program.screenshot) {
        saveScreenshot(frame, program.screenshot);
    }
    if (program.ascii) {
        const canvas = createCanvas(frame.width, frame.height);
        const ctx = canvas.getContext("2d");
        canvas.width = frame.width;
        canvas.height = frame.height;
        ctx.putImageData(frame, 0, 0);
        const columns = typeof program.ascii === "number" && program.ascii > 0 ? program.ascii : maxColumns;
        if (program.unicode) {
            printFrame(renderUnicodeFrame(columns, canvas));
        } else {
            printFrame(renderAsciiFrame(columns, canvas));
        }
    }
}

/**
 * Finalizes a worker-mode run when the engine worker reports the app has exited.
 * Terminates the engine, ECP, and any Task workers, then prints the exit banner.
 * @param exitReason - The AppExitReason reported by the engine worker.
 */
function finalizeRun(exitReason: string) {
    appWorker?.terminate();
    brsWorker?.terminate();
    for (const worker of taskWorkers.values()) {
        worker.terminate();
    }
    taskWorkers.clear();
    threadSyncToTask.clear();
    threadSyncToMain.clear();
    const msg = `------ Finished '${appFileName}' execution [${exitReason}] ------\n`;
    if (exitReason === AppExitReason.UserNav) {
        console.log(chalk.blueBright(msg));
    } else {
        process.exitCode = 1;
        console.log(chalk.redBright(msg));
    }
}

/**
 * Parses and displays string messages from the interpreter.
 * Message format: "type,content" where type is print, warning, error, end, etc.
 * @param message - The message string to parse and display
 */
function handleStringMessage(message: string) {
    const mType = message.split(",")[0];
    const msg = message.slice(mType.length + 1);
    if (mType === "print" && msg.endsWith(DebugPrompt)) {
        process.stdout.write(msg);
    } else if (mType === "print") {
        process.stdout.write(colorize(msg));
    } else if (mType === "warning") {
        console.warn(chalk.yellow(msg.trimEnd()));
    } else if (mType === "error") {
        console.error(chalk.red(msg.trimEnd()));
        process.exitCode = 1;
    } else if (mType === "debug") {
        if (program.verbose) {
            console.debug(chalk.gray(msg.trimEnd()));
        }
    } else if (mType === "audio") {
        handleAudioControl(msg);
    } else if (mType === "end" && msg.trimEnd() !== AppExitReason.UserNav) {
        process.exitCode = 1;
    } else if (!["start", "command", "reset", "video", "audio", "syslog", "end"].includes(mType)) {
        console.info(chalk.blueBright(message.trimEnd()));
    }
}

/**
 * Simulates the audio-playback state machine for the headless CLI. A real device (and the
 * browser host in api/sound.ts) plays the stream and writes MediaEvent flags into the shared
 * array; the engine polls those (SGRoot.processAudio -> Audio.setState) to drive the node's
 * `state` field. Headless has no audio device, so we mirror the lifecycle (playing/paused/
 * resumed/stopped) without decoding audio, keeping playback logic faithfully testable.
 *
 * Note: the transition is reported immediately rather than via a simulated buffering delay,
 * because the engine worker floods the main thread with render frames and starves macrotask
 * timers (setTimeout); Atomics writes from a worker 'message' handler stay reliable.
 * @param control The audio control verb forwarded by the engine (e.g. "play", "pause").
 */
function handleAudioControl(control: string) {
    const action = control.split(",")[0];
    const signal = (event: number) => {
        Atomics.store(sharedArray, DataType.SND, event);
        Atomics.notify(sharedArray, DataType.SND);
    };
    if (action === "play" || action === "start") {
        signal(MediaEvent.StartStream);
    } else if (action === "pause") {
        signal(MediaEvent.Paused);
    } else if (action === "resume") {
        signal(MediaEvent.Resumed);
    } else if (action === "stop") {
        signal(-1);
    }
}

/**
 * Applies color formatting to console messages using chalk.
 * Highlights keywords, numbers, emails, URLs, and quoted strings with different colors.
 * @param log - The log message to colorize
 * @returns The colorized string with ANSI color codes
 */
function colorize(log: string) {
    return log
        .replace(/\b(down|error|errors|failure|fail|fatal|false)(:|\b)/gi, chalk.red("$1$2"))
        .replace(/\b(warning|warn|test|null|undefined|invalid)(:|\b)/gi, chalk.yellow("$1$2"))
        .replace(/\b(help|hint|info|information|true|log)(:|\b)/gi, chalk.cyan("$1$2"))
        .replace(/\b(running|success|successfully|valid)(:|\b)/gi, chalk.green("$1$2"))
        .replace(/\b(debug|roku|brs|brightscript)(:|\b)/gi, chalk.magenta("$1$2"))
        .replace(/(\b\d+\.?\d*?\b)/g, chalk.ansi256(122)(`$1`)) // Numeric
        .replace(/\S+@\S+\.\S+/g, (match: string) => {
            return chalk.blueBright(stripAnsi(match)); // E-Mail
        })
        .replace(/\b([a-z]+):\/{1,2}[^\/].*/gi, (match: string) => {
            return chalk.blue.underline(stripAnsi(match)); // URL
        })
        .replace(/<(.*?)>/g, (match: string) => {
            return chalk.greenBright(stripAnsi(match)); // Delimiters < >
        })
        .replace(/"(.*?)"/g, (match: string) => {
            return chalk.ansi256(222)(stripAnsi(match)); // Quotes
        });
}

/**
 * Display the help message on the console.
 */
function printHelp() {
    let helpMsg = "\r\n";
    helpMsg += "REPL Command List:\r\n";
    helpMsg += "   print|?           Print variable value or expression\r\n";
    helpMsg += "   var|vars [scope]  Display variables and their types/values\r\n";
    helpMsg += "   vol|vols          Display file system mounted volumes\r\n";
    helpMsg += "   mnt|mount <path>  Mount ext1: volume from directory or zip file\r\n";
    helpMsg += "   umt|umount        Unmount ext1: volume\r\n";
    helpMsg += "   xt|ext            Display loaded extensions\r\n";
    helpMsg += "   help|hint         Show this REPL command list\r\n";
    helpMsg += "   clear|cls         Clear terminal screen\r\n";
    helpMsg += "   exit|quit|q       Terminate REPL session\r\n\r\n";
    helpMsg += "   Type any valid BrightScript expression for a live compile and run.\r\n";
    process.stdout.write(chalk.cyanBright(helpMsg));
}
