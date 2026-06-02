#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  brs analyze — preflight static analysis for a Roku channel package.
 *
 *  Mirrors (a subset of) Roku's dashboard "Store Analysis" so issues surface LOCALLY, before
 *  upload — closing the gap where the runtime engine compiled/ran a channel fine but the
 *  dashboard then flagged package/manifest/asset problems. Checks here are grounded in real
 *  warnings observed on the AudioShelf channel (see AudioShelf-Roku LIFECYCLE_PAINPOINTS 2.2b).
 *
 *  Usage:  node scripts/analyze.js <channel.zip>
 *  Exit:   1 if any ERROR finding, else 0 (warnings/info do not fail).
 *--------------------------------------------------------------------------------------------*/
"use strict";
const fs = require("fs");
const { unzipSync, strFromU8 } = require("fflate");

// A Roku channel needs only these top-level entries; anything else is "extraneous".
const ALLOWED_TOP = new Set(["manifest", "source", "components", "images", "data", "fonts", "locale"]);
const UI_HD = { w: 1280, h: 720 };
// splash screens and channel icons are NOT scene textures, so they are exempt from the
// "texture larger than UI resolution" check (they are meant to be full/large images).
const NON_TEXTURE = /^images\/(splash|icon)/i;

function pngSize(buf) {
    if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
    const rd = (o) => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
    return { w: rd(16), h: rd(20) };
}

function jpgSize(buf) {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        // SOF0..SOF15 carry dimensions, excluding DHT(C4), DNL(C8), DAC(CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { h: (buf[i + 5] << 8) | buf[i + 6], w: (buf[i + 7] << 8) | buf[i + 8] };
        }
        i += 2 + ((buf[i + 2] << 8) | buf[i + 3]);
    }
    return null;
}

function imageSize(name, buf) {
    const n = name.toLowerCase();
    if (n.endsWith(".png")) return pngSize(buf);
    if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return jpgSize(buf);
    return null;
}

function parseManifest(text) {
    const m = {};
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq > 0) m[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return m;
}

function analyze(zipPath) {
    const f = [];
    const add = (severity, category, message) => f.push({ severity, category, message });

    let files;
    try {
        files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
    } catch (e) {
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

    return f;
}

function main() {
    const zip = process.argv[2];
    if (!zip) {
        console.error("usage: node scripts/analyze.js <channel.zip>");
        process.exit(2);
    }
    const findings = analyze(zip);
    const order = { error: 0, warning: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category));
    const counts = { error: 0, warning: 0, info: 0 };
    for (const x of findings) counts[x.severity]++;

    console.log(`\nbrs analyze — ${zip}`);
    console.log("=".repeat(64));
    if (findings.length === 0) console.log("  No issues found.");
    for (const x of findings) console.log(`  [${x.severity.toUpperCase().padEnd(7)}] ${x.category}: ${x.message}`);
    console.log("=".repeat(64));
    console.log(`  ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info\n`);
    process.exit(counts.error > 0 ? 1 : 0);
}

main();
