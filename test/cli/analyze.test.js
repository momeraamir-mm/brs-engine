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
