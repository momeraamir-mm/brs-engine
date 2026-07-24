/*---------------------------------------------------------------------------------------------
 *  brs analyze — preflight static analysis for a Roku channel package.
 *
 *  Mirrors (a subset of) Roku's dashboard "Store Analysis" + certification static checks so
 *  issues surface LOCALLY, before upload — closing the gap where the runtime engine compiled/ran
 *  a channel fine but the dashboard then flagged package/manifest/asset/cert problems. Checks are
 *  grounded in real warnings observed on the AudioShelf channel (see LIFECYCLE_PAINPOINTS 2.2b/3.4b).
 *
 *  Exposed via the CLI: `brs-cli --analyze <channel.zip> [--prev <published-version>]`.
 *  Exit code: 1 if any ERROR finding, else 0 (warnings/info do not fail).
 *--------------------------------------------------------------------------------------------*/
import fs from "node:fs";
import { unzipSync, strFromU8 } from "fflate";

type Severity = "error" | "warning" | "info";
interface Finding {
    severity: Severity;
    category: string;
    message: string;
}

export interface AnalyzeOptions {
    prev?: string;
    /** Also run the house coding-standards checks (category "Standards"). Off by default
     *  so the cert preflight stays focused on Store rules; the generator/Evaluator opts in. */
    standards?: boolean;
}

// A Roku channel needs only these top-level entries; anything else is "extraneous".
const ALLOWED_TOP = new Set(["manifest", "source", "components", "images", "data", "fonts", "locale"]);
const UI_HD = { w: 1280, h: 720 };
// splash screens and channel icons are NOT scene textures, so they are exempt from the
// "texture larger than UI resolution" check (they are meant to be full/large images).
const NON_TEXTURE = /^images\/(splash|icon)/i;

function pngSize(buf: Uint8Array): { w: number; h: number } | null {
    if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
    const rd = (o: number) => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
    return { w: rd(16), h: rd(20) };
}

function jpgSize(buf: Uint8Array): { w: number; h: number } | null {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
            i++;
            continue;
        }
        const marker = buf[i + 1];
        // SOF0..SOF15 carry dimensions, excluding DHT(C4), DNL(C8), DAC(CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { h: (buf[i + 5] << 8) | buf[i + 6], w: (buf[i + 7] << 8) | buf[i + 8] };
        }
        i += 2 + ((buf[i + 2] << 8) | buf[i + 3]);
    }
    return null;
}

function imageSize(name: string, buf: Uint8Array): { w: number; h: number } | null {
    const n = name.toLowerCase();
    if (n.endsWith(".png")) return pngSize(buf);
    if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return jpgSize(buf);
    return null;
}

// Compares two [major, minor, build] version tuples: -1 / 0 / 1.
function compareVersion(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] || 0) - (b[i] || 0);
        if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
}

/**
 * BrightScript source with comments removed and string CONTENTS blanked, line structure intact.
 *
 * The Standards rules are text scans, and a scan that cannot tell code from prose flags the
 * prose. An authored channel whose Task carried the comment `' never a callFunc across the
 * thread boundary` was failed for "callFunc in a Task" — the file contained no callFunc at all.
 * The rule flagged a comment documenting compliance with that very rule, which also punishes
 * exactly the code most worth writing. Blanking string contents kills the same false positive
 * for `x = "callFunc"`.
 *
 * Composed channels never surfaced this: their comments were written against these rules. It
 * took a channel authored from scratch to hit it.
 */
function codeOnly(src: string): string {
    return src.split("\n").map(stripLine).join("\n");
}

/**
 * One line with any `'` comment removed but STRING CONTENTS INTACT.
 *
 * The font rule needs the opposite of codeOnly(): it is looking for a string literal, so it
 * cannot use a helper that blanks strings — but it still must not read a comment, or a line
 * documenting the rule would trip it (the false-positive shape the callFunc rule was fixed for).
 */
function stripBrsComment(line: string): string {
    let out = "";
    let inStr = false;
    for (const c of line) {
        if (c === '"') inStr = !inStr;
        if (c === "'" && !inStr) break; // comment runs to end of line
        out += c;
    }
    return out;
}

/** One line: drop a `'` or `REM` comment, blank string contents, keep everything else in place. */
function stripLine(line: string): string {
    let out = "";
    let inStr = false;
    for (const c of line) {
        if (inStr) {
            // A `""` escape closes then reopens; either way the content stays blanked.
            out += c === '"' ? '"' : " ";
            if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') {
            inStr = true;
            out += c;
            continue;
        }
        if (c === "'") break; // comment runs to end of line
        out += c;
    }
    const rem = /(?:^|:)\s*\bREM\b/i.exec(out);
    return rem ? out.slice(0, rem.index) : out;
}

function parseManifest(text: string): Record<string, string> {
    const m: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq > 0) m[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return m;
}

/**
 * Runs the static preflight analysis over a channel zip and returns the findings.
 * @param zipPath Path to the channel .zip package.
 * @param opts Analysis options (e.g. prev published version for the bump check).
 * @returns The list of findings (severity/category/message).
 */
export function analyze(zipPath: string, opts: AnalyzeOptions = {}): Finding[] {
    const f: Finding[] = [];
    const add = (severity: Severity, category: string, message: string) => f.push({ severity, category, message });

    let files: Record<string, Uint8Array>;
    try {
        files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
    } catch (e: any) {
        add("error", "Package", `Cannot read zip: ${e.message}`);
        return f;
    }
    const names = Object.keys(files).filter((n) => !n.endsWith("/"));

    // --- Package: extraneous files ---
    for (const n of names) {
        const top = n.split("/")[0];
        if (top === "manifest") continue;
        if (!ALLOWED_TOP.has(top)) add("warning", "Package", `Extraneous file (not part of a channel): ${n}`);
        else if (/\.(md|py|pyc|txt|gitignore)$/i.test(n) || /(^|\/)(\.DS_Store|Thumbs\.db)$/i.test(n))
            add("warning", "Package", `Extraneous file (non-channel type): ${n}`);
    }

    // --- Manifest ---
    if (!files["manifest"]) {
        add("error", "Manifest", "Missing manifest at archive root.");
        return f;
    }
    const man = parseManifest(strFromU8(files["manifest"]));
    for (const key of ["title", "major_version", "minor_version", "build_version"]) {
        if (!man[key]) add("warning", "Manifest", `Manifest missing recommended key: ${key}`);
    }
    if (!man["rsg_version"]) {
        add("warning", "Manifest", "Manifest should declare rsg_version (e.g. rsg_version=1.2).");
    } else if (parseFloat(man["rsg_version"]) >= 1.2) {
        add("info", "Channel Store", "rsg_version>=1.2 expects a Dashboard minimum firmware of 11.5+ — verify the Dashboard setting.");
    }
    // Certification manifest completeness (HD+FHD splash + channel icon are cert MUSTs).
    for (const key of ["splash_screen_hd", "splash_screen_fhd", "mm_icon_focus_hd"]) {
        if (!man[key]) add("warning", "Certification", `Manifest missing ${key} — required for certification.`);
    }

    // --- Assets: textures larger than UI resolution (the scene posters) ---
    for (const n of names) {
        if (!/^images\//i.test(n) || NON_TEXTURE.test(n)) continue;
        const sz = imageSize(n, files[n]);
        if (sz && (sz.w > UI_HD.w || sz.h > UI_HD.h))
            add("warning", "Assets", `Texture ${sz.w}x${sz.h} larger than UI resolution (${UI_HD.w}x${UI_HD.h}): ${n}`);
    }

    // --- Package size (uncompressed) ---
    let total = 0;
    for (const n of names) total += files[n].length;
    const mb = total / 1048576;
    if (mb > 4) add("info", "Package", `Uncompressed size ${mb.toFixed(1)} MB — keep channels lean for fast load.`);

    // --- Code usage: deep-link cert-readiness (Direct-to-Play is cert-mandatory) ---
    const brsText = names.filter((n) => /\.brs$/i.test(n)).map((n) => strFromU8(files[n])).join("\n");
    const hasMainArgs = /\b(?:sub|function)\s+Main\s*\(\s*[A-Za-z_]/i.test(brsText);
    const hasMainNoArgs = /\b(?:sub|function)\s+Main\s*\(\s*\)/i.test(brsText);
    if (hasMainNoArgs && !hasMainArgs)
        add("warning", "Certification", "Main() takes no args — deep linking is cert-mandatory; entry must be Main(args) to receive a launch contentId.");
    if (!/roInput/i.test(brsText))
        add("warning", "Certification", "No roInput usage found — deep links arriving while the app runs won't be handled (cert-mandatory).");
    if (!/contentId/i.test(brsText))
        add("warning", "Certification", "No contentId handling found — Direct-to-Play deep linking is cert-mandatory.");
    // The manifest must ADVERTISE deep-link capability — code alone is not enough.
    // Without supports_input_launch, Roku Static Analysis reports the channel as
    // deep-linking-unsupported (isDeepLinkingSupportEnabled=false) even when the
    // BrightScript handles contentId/roInput correctly (the D54 defect).
    const implementsDeepLink = hasMainArgs && /roInput/i.test(brsText) && /contentId/i.test(brsText);
    if (implementsDeepLink && !man["supports_input_launch"])
        add("warning", "Certification", "Manifest missing supports_input_launch=1 — the channel implements deep linking in code but does not advertise it, so Roku Static Analysis reports deep linking as unsupported (cert-mandatory).");
    if (implementsDeepLink && !/mediaType/i.test(brsText))
        add("info", "Certification", "No mediaType handling found — Roku deep links carry both contentId and mediaType; accept (and tolerate) mediaType alongside contentId.");

    // --- Code usage: monetization consistency (the real Billing 2.5 ERROR we hit) ---
    if (/roChannelStore/i.test(brsText))
        add("info", "Monetization", "roChannelStore usage found — ensure the Dashboard Monetization declares in-channel products (a code/Dashboard mismatch fails Store Analysis).");
    else if (/pay-to-install/i.test(brsText))
        add("info", "Monetization", "Pay-to-install marker found — the install charge is store-gated, so NO in-channel billing code is required; ensure Dashboard Monetization is set to PayToInstall (not Free) with a price tier.");
    else
        add("info", "Monetization", "No roChannelStore/Roku Pay usage — ensure Dashboard Monetization is set to Free (or PayToInstall, which needs no IAP code); a subscription/IAP 'charging' setting with no IAP code triggers the Billing 2.5 ERROR.");

    // --- Versioning: non-zero + bump vs the previously published build ---
    const curVer = [man["major_version"], man["minor_version"], man["build_version"]].map((v) => parseInt(v, 10) || 0);
    if (curVer.every((v) => v === 0))
        add("warning", "Certification", "Manifest version is 0.0.0 — certification requires a non-zero version.");
    if (opts.prev) {
        const prevVer = String(opts.prev).split(".").map((v) => parseInt(v, 10) || 0);
        if (compareVersion(curVer, prevVer) <= 0)
            add("error", "Versioning", `Version ${curVer.join(".")} is not greater than published ${prevVer.join(".")} — bump the version before re-publishing (the Dashboard rejects an un-bumped update).`);
        else
            add("info", "Versioning", `Version ${curVer.join(".")} > published ${prevVer.join(".")} — OK.`);
    } else {
        add("info", "Versioning", `Version ${curVer.join(".")} — pass --prev <published-version> to verify it was bumped vs the published build.`);
    }

    // --- Fonts: every `font="font:X"` must name a real system font -------------------------
    //
    // NOT opt-in, deliberately. This is not a style rule: on REAL HARDWARE an unrecognised
    // system-font name makes the Label render NOTHING AT ALL — silently. No crash, no error, no
    // fallback face. Device-verified 2026-07-22 by an A/B probe on a Streaming Stick (15.2.4):
    // the same Label reads "Ag123" with `font:LargeBoldSystemFont` and is blank with
    // `font:NotARealFont`, everything else on screen untouched.
    //
    // On THIS simulator the same markup throws instead (parseFont returns invalid and
    // Label.renderLabel calls a method on it), so the sim fails loudly and the device fails
    // silently. That divergence is why a static check has to exist: every runtime gate we own
    // asks "did it boot", and on device a channel with invisible text boots perfectly.
    //
    // High precision by construction — the legal set is CLOSED and enumerable, so this cannot
    // false-positive on valid code the way a fuzzy text scan can. Scoped narrowly to the two
    // forms that actually take a system-font NAME: the `font=` attribute in XML and a
    // `.font = "font:..."` assignment in BrightScript. A `<Font uri="...">` child is a font FILE
    // reference and is NOT checked here (device testing showed an unknown uri there still
    // renders, honouring `size` and falling back on the face).
    const SYSTEM_FONTS = new Set([
        "BadgeSystemFont",
        "TinySystemFont", "TinyBoldSystemFont",
        "SmallestSystemFont", "SmallestBoldSystemFont",
        "SmallerSystemFont", "SmallerBoldSystemFont",
        "SmallSystemFont", "SmallBoldSystemFont",
        "MediumSystemFont", "MediumBoldSystemFont",
        "LargeSystemFont", "LargeBoldSystemFont",
        "ExtraLargeSystemFont", "ExtraLargeBoldSystemFont",
        "LargestSystemFont",
    ]);
    const badFonts = new Map<string, string>(); // name -> first file it appeared in
    const noteFont = (name: string, where: string) => {
        if (!SYSTEM_FONTS.has(name) && !badFonts.has(name)) badFonts.set(name, where);
    };
    for (const n of names) {
        if (/\.xml$/i.test(n)) {
            // Strip XML comments first: a comment documenting the rule must not trip it (the
            // same false-positive shape the callFunc rule was fixed for).
            const xml = strFromU8(files[n]).replace(/<!--[\s\S]*?-->/g, "");
            const re = /\bfont\s*=\s*"font:([^"]*)"/gi;
            let m: RegExpExecArray | null;
            while ((m = re.exec(xml)) !== null) noteFont(m[1].trim(), n);
        } else if (/\.brs$/i.test(n)) {
            const src = strFromU8(files[n]);
            for (const raw of src.split("\n")) {
                const line = stripBrsComment(raw);
                const re = /\.font\s*=\s*"font:([^"]*)"/gi;
                let m: RegExpExecArray | null;
                while ((m = re.exec(line)) !== null) noteFont(m[1].trim(), n);
            }
        }
    }
    for (const [name, where] of badFonts) {
        add("error", "Fonts",
            `Unknown system font "font:${name}" in ${where} — renders NOTHING on a real device ` +
            `(silently) and throws in the simulator. Use one of: ${[...SYSTEM_FONTS].join(", ")}.`);
    }

    // --- House coding standards (opt-in via --standards; category "Standards") ---
    // The mechanically-checkable subset of BRIGHTSCRIPT_STDS / SCENEGRAPH_STDS. High-
    // confidence rules are ERRORs (fail the build, feed the Evaluator retry); fuzzy ones
    // are WARNINGs to review. Judgment rules (architecture, minimal diffs) are NOT linted —
    // they live in the standards docs + human review.
    if (opts.standards) {
        const brsNames = names.filter((n) => /\.brs$/i.test(n));
        const xmlNames = names.filter((n) => /\.xml$/i.test(n));
        // Scan CODE, not prose — see codeOnly(). The cert checks above deliberately keep using
        // the raw text: they are presence checks ("does this channel mention roInput"), and
        // tightening them would newly fail already-published channels — a separate call.
        const code = new Map<string, string>();
        for (const n of brsNames) code.set(n, codeOnly(strFromU8(files[n])));
        const brsCode = brsNames.map((n) => code.get(n) ?? "").join("\n");
        // Which .brs run on a Task thread? A component whose xml extends a "*Task" base
        // contributes its <script uri> files (and its own sibling .brs).
        const taskBrs = new Set<string>();
        for (const xn of xmlNames) {
            const xml = strFromU8(files[xn]);
            const ext = /extends\s*=\s*"([^"]+)"/i.exec(xml);
            if (!ext || !/task/i.test(ext[1])) continue;
            const uriRe = /uri\s*=\s*"pkg:\/([^"]+\.brs)"/gi;
            let um: RegExpExecArray | null;
            while ((um = uriRe.exec(xml)) !== null) taskBrs.add(um[1].toLowerCase());
            taskBrs.add(xn.replace(/\.xml$/i, ".brs").toLowerCase());
        }
        const isTask = (n: string) => taskBrs.has(n.toLowerCase());

        // R1 — `option explicit` is not valid BrightScript (compile error on device).
        if (/\boption\s+explicit\b/i.test(brsCode))
            add("error", "Standards", "`option explicit` found — not valid BrightScript; rely on typed signatures instead.");

        // R2 — no HTTP/file I/O outside a Task; R3 — never callFunc across threads.
        const IO = /\b(roUrlTransfer|ReadAsciiFile|WriteAsciiFile|MoveFile|DeleteFile|CopyFile|ListDir|roFileSystem)\b/;
        for (const n of brsNames) {
            const txt = code.get(n) ?? "";
            const io = IO.exec(txt);
            if (io && !isTask(n))
                add("error", "Standards", `HTTP/file I/O (${io[1]}) outside a Task in ${n} — move it into a Task component.`);
            if (/\bcallFunc\b/i.test(txt) && isTask(n))
                add("error", "Standards", `callFunc in a Task (${n}) crosses threads — Task→Scene handoff must be field copies only.`);
        }

        // R4 — typed signatures: a function/sub should declare an `as <type>` return (warning).
        let untyped = 0;
        for (const line of brsCode.split("\n")) {
            const m = /^\s*(?:function|sub)\s+(\w+)\s*\([^)]*\)\s*(.*)$/i.exec(line);
            if (m && !/\bas\s+\w/i.test(m[2])) {
                untyped++;
                if (untyped <= 5)
                    add("warning", "Standards", `Untyped signature '${m[1]}()' — declare an 'as <type>' return (typed signatures required).`);
            }
        }
        if (untyped > 5) add("warning", "Standards", `... and ${untyped - 5} more untyped signature(s).`);

        // R5 — deep-link handler must be present (cert-mandatory); ERROR in standards mode.
        if (!implementsDeepLink)
            add("error", "Standards", "Deep-link handler incomplete — need Main(args) + roInput + contentId routing (cert-mandatory Direct-to-Play).");

        // R6 — screensaver cert gate: a Video node suppresses Roku's system screensaver, which
        // cert 4.5 forbids overriding. Detected from the ACTUAL node in the built channel — NOT
        // from a self-declared `mm_media` label (our own invention, which could be absent or
        // wrong, and which made this rule skip silently). Reading reality makes it always run and
        // unspoofable. Emitted as a WARNING, not an error, because static analysis cannot tell a
        // legitimate video-playback app (suppression-while-watching is expected) from an improper
        // idle/ambient suppression — that legitimacy is a runtime/store-category judgment.
        const hasVideoNode =
            xmlNames.some((xn) => /<Video[\s/>]/i.test(strFromU8(files[xn]))) ||
            /createObject\s*\(\s*"roSGNode"\s*,\s*"Video"\s*\)/i.test(brsCode) ||
            /createObject\s*\(\s*"roVideoPlayer"\s*\)/i.test(brsCode);
        if (hasVideoNode)
            add("warning", "Standards", "Contains a Video node — a Video node suppresses Roku's system screensaver (cert 4.5 forbids overriding it). Permitted only while actively presenting video the user chose to watch; verify it is not left running during idle/ambient use (an audio-only or ambient app must use an Audio node instead).");

        // NOTE: "no >1 Hz hot field on the visual tree" is intentionally NOT linted — update
        // frequency isn't statically determinable (the device-validated reference uses
        // alwaysNotify on low-frequency bridge command fields, which a blanket check would
        // mis-flag). It stays a documented judgment rule for human review, not a linter check.
    }

    return f;
}

/**
 * Runs the analysis, prints a human-readable report, and returns a process exit code.
 * @param zipPath Path to the channel .zip (undefined prints usage).
 * @param opts Analysis options.
 * @returns 0 (clean / warnings only), 1 (had an ERROR finding), or 2 (usage error).
 */
export function runAnalyze(zipPath: string | undefined, opts: AnalyzeOptions = {}): number {
    if (!zipPath) {
        console.error("usage: brs-cli --analyze <channel.zip> [--prev <published-version>]");
        return 2;
    }
    const findings = analyze(zipPath, opts);
    const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category));
    const counts = { error: 0, warning: 0, info: 0 };
    for (const x of findings) counts[x.severity]++;

    console.log(`\nbrs analyze — ${zipPath}`);
    console.log("=".repeat(64));
    if (findings.length === 0) console.log("  No issues found.");
    for (const x of findings) console.log(`  [${x.severity.toUpperCase().padEnd(7)}] ${x.category}: ${x.message}`);
    console.log("=".repeat(64));
    console.log(`  ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info\n`);
    return counts.error > 0 ? 1 : 0;
}
