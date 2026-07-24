const child_process = require("child_process");
const path = require("path");
const { promisify } = require("util");

const exec = promisify(child_process.exec);
const brsCliPath = path.join(process.cwd(), "packages", "node", "bin", "brs.cli.js");

// Regression coverage for the `--analyze --standards` "callFunc in a Task" rule (R3 in
// src/cli/analyze.ts), which scans codeOnly() output (comments stripped, string contents
// blanked) rather than raw source. Before that fix, a Task whose comment merely DOCUMENTED
// the rule (e.g. "never a callFunc across the thread boundary") was flagged as a violation —
// an autonomous repair loop would "fix" that by deleting the accurate comment, converging on
// a worse channel while hiding the analyzer bug. Precision (no false positive on prose) and
// recall (still catches a real callFunc-in-a-Task) are both asserted — proving precision by
// defeating recall would be worthless.
const CALLFUNC_IN_TASK_MSG = "callFunc in a Task (components/WorkerTask.brs) crosses threads";

// Regression coverage for the "Fonts" rule (src/cli/analyze.ts), which is NOT opt-in.
//
// Why it must exist at all: on REAL HARDWARE an unrecognised system-font name makes the Label
// render NOTHING — silently, no crash, no fallback (device-verified 2026-07-22, Streaming Stick
// 15.2.4, A/B probe). This simulator throws on the same markup instead, so the sim fails loudly
// and the device fails silently: a channel with invisible text boots green and passes every
// runtime gate that asks "did it boot". A static check is the only thing that catches it.
//
// The two fixtures are IDENTICAL apart from the font names, so the pair proves recall and
// precision on the same shape — proving precision by defeating recall would be worthless.
// The valid fixture deliberately carries three false-positive traps: a bogus font name in an
// XML comment, another in a BrightScript comment, and a `<Font uri="...">` FILE reference
// (which is not a system-font name and must not be checked).
const BAD_XML_FONT = 'Unknown system font "font:NotARealFont" in components/FixtureScene.xml';
const BAD_BRS_FONT = 'Unknown system font "font:AlsoNotReal" in components/FixtureScene.brs';

describe("analyze: unknown system-font rule", () => {
    it("stays SILENT on valid fonts, comments naming bogus fonts, and <Font uri> files", async () => {
        const command = ["node", brsCliPath, "--analyze", "analyze-font-valid.zip"].join(" ");
        const { stdout } = await exec(command, { cwd: path.join(__dirname, "resources") });
        expect(stdout).not.toContain("Fonts:");
        expect(stdout).toContain("0 error(s)");
    }, 10000);

    it("fires on an unknown font in an XML font= attribute AND a BRS .font assignment", async () => {
        const command = ["node", brsCliPath, "--analyze", "analyze-font-bad.zip"].join(" ");
        try {
            await exec(command, { cwd: path.join(__dirname, "resources") });
            throw new Error("expected brs-cli --analyze to exit non-zero (ERROR findings present)");
        } catch (err) {
            expect(err.stdout).toContain(BAD_XML_FONT);
            expect(err.stdout).toContain(BAD_BRS_FONT);
        }
    }, 10000);
});

describe("analyze --standards: callFunc-in-Task rule precision", () => {
    it("does NOT fire on a comment merely describing the rule (no real callFunc)", async () => {
        let command = ["node", brsCliPath, "--analyze", "analyze-task-comment-only.zip", "--standards"].join(" ");

        // The fixture still trips an unrelated Standards ERROR (deep-link handler incomplete),
        // so brs-cli exits 1 and `exec` rejects — only the callFunc-in-Task message matters here.
        try {
            await exec(command, {
                cwd: path.join(__dirname, "resources"),
            });
            throw new Error("expected brs-cli --analyze to exit non-zero (unrelated ERROR finding present)");
        } catch (err) {
            expect(err.stdout).not.toContain(CALLFUNC_IN_TASK_MSG);
        }
    }, 10000);

    it("still fires on a genuine callFunc(...) call inside a Task", async () => {
        let command = ["node", brsCliPath, "--analyze", "analyze-task-real-callfunc.zip", "--standards"].join(" ");

        try {
            await exec(command, {
                cwd: path.join(__dirname, "resources"),
            });
            throw new Error("expected brs-cli --analyze to exit non-zero (an ERROR finding present)");
        } catch (err) {
            expect(err.stdout).toContain(CALLFUNC_IN_TASK_MSG);
        }
    }, 10000);
});

// R6 — the screensaver/Video-node cert rule fires from the ACTUAL node, not a declared
// `mm_media` label (removed as taxonomy). Both directions are asserted: silent on a channel with
// no Video node, fires (as a warning) on any Video node. Both fixtures trip an unrelated deep-link
// ERROR (exit 1, exec rejects), so only the Video-node message is asserted, on either path.
const VIDEO_NODE_MSG = "Contains a Video node";

describe("analyze --standards: Video-node screensaver rule (R6)", () => {
    it("stays SILENT on a channel with no Video node", async () => {
        const command = ["node", brsCliPath, "--analyze", "analyze-task-comment-only.zip", "--standards"].join(" ");
        try {
            const { stdout } = await exec(command, { cwd: path.join(__dirname, "resources") });
            expect(stdout).not.toContain(VIDEO_NODE_MSG);
        } catch (err) {
            expect(err.stdout).not.toContain(VIDEO_NODE_MSG);
        }
    }, 10000);

    it("fires (as a warning) on any Video node, regardless of a declared media label", async () => {
        const command = ["node", brsCliPath, "--analyze", "analyze-video-node.zip", "--standards"].join(" ");
        try {
            const { stdout } = await exec(command, { cwd: path.join(__dirname, "resources") });
            expect(stdout).toContain(VIDEO_NODE_MSG);
        } catch (err) {
            expect(err.stdout).toContain(VIDEO_NODE_MSG);
        }
    }, 10000);
});
