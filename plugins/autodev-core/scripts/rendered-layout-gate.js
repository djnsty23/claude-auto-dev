#!/usr/bin/env node
'use strict';
/**
 * rendered-layout-gate.js - layout defects found on a RENDERED page, element by
 * element, at several widths.
 *
 * Two items from the rendered-page half of the frontend-design-deslop slop
 * checklist (samber/cc-skills, MIT), both mechanically checkable rather than a
 * taste call:
 *
 *   item 6  nothing overflows its container, and nothing forces an unintended
 *           horizontal scrollbar
 *   item 2  no text occluded by an overlapping element
 *
 * Two done properly beats six done vaguely, so the other four are not here.
 *
 * ------------------------------------------------------------------ HOW IT RUNS
 *
 * Three pieces, and the split is the point:
 *
 *   layout-probe.js    runs IN the browser, harvests, judges nothing
 *   layout-checks.js   pure, judges, never touches a DOM
 *   this file          reads snapshots, prints the report
 *
 * The plugin ships the measurement and the calling session supplies the
 * browser, so this works from the in-app pane, chrome-devtools, or Playwright
 * without any of them being a dependency of the plugin. `--how` prints the
 * capture recipe.
 *
 * --------------------------------------------------------------- PER WIDTH
 *
 * Never one verdict. A defect present at 360 and absent at 390 is a defect, and
 * collapsing the widths is exactly how it disappears. 360, 390, 414, 768 and
 * 1280 is a reasonable starting set.
 *
 * ------------------------------------------------------------- ADVISORY
 *
 * Exit 0 even with findings. `--strict` exits 1 for a caller who wants a red.
 * Nothing in this repo passes it, and it should stay that way until this gate
 * has a measured precision on real pages. A check with demonstrated false
 * positives that can turn a build red gets muted, and a muted check stops
 * catching the real thing.
 *
 * The false-positive count that argument is not hypothetical about: on the
 * committed clean control, the naive form of the overflow check fires on five
 * carousel cards that are correct. See `--how` for what the exemptions cost.
 */

const fs = require('fs');
const path = require('path');

const CHECKS = require(path.join(__dirname, 'layout-checks.js'));
const PROBE = require(path.join(__dirname, 'layout-probe.js'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DEFAULT_WIDTHS = [360, 390, 414, 768, 1280];

function usage() {
    console.log(`rendered-layout-gate.js - rendered-page layout defects, per width.

  node rendered-layout-gate.js <snapshot.json> [more.json ...]
  node rendered-layout-gate.js --dir <directory of snapshots>
  node rendered-layout-gate.js --how              capture recipe, step by step
  node rendered-layout-gate.js --print-probe [--width 360]
  node rendered-layout-gate.js --selftest

  --json            machine-readable report on stdout
  --strict          exit 1 on any finding or refusal (default: advisory, exit 0)
  --quiet           findings and the population line only

Thresholds, all overridable:
${Object.entries(CHECKS.DEFAULTS).map(([k, v]) => `  --${k} <n>`.padEnd(30) + `default ${v}`).join('\n')}

Exit: 0 clean or advisory, 1 findings under --strict, 2 could not run.`);
}

function how() {
    console.log(`CAPTURING A SNAPSHOT

Serve the page over http. A file:// page is handed to the pane as a data: URL,
where width emulation silently does nothing and every reading is taken at ~980px.

1. Size the viewport FIRST, then load the page.
2. Evaluate the probe and keep what it returns:

     node ${path.basename(__filename)} --print-probe --width 360

   Paste that expression into whatever browser evaluation tool you have
   (javascript_tool, evaluate_script, page.evaluate). Save the JSON as
   <page>-<width>.json.
3. Repeat per width: ${DEFAULT_WIDTHS.join(', ')}.
4. node ${path.basename(__filename)} --dir ./snapshots

THE ONE ASSERTION THAT MATTERS. The gate refuses any snapshot whose
documentElement.clientWidth is not the width you asked for. Resize tools report
success and silently do nothing, and a page measured at 1280 while labelled 360
reads as a clean mobile layout.

Asserting window.innerWidth instead is NOT enough, and this is measured. A page
carrying a 900px child, emulated at 360:

    innerWidth 917    clientWidth 360    scrollWidth 917

innerWidth is the visual viewport and follows the browser's zoom-to-fit, so
"scrollWidth > innerWidth" is 917 > 917, false, on a page that plainly scrolls
sideways. Against the committed fixtures that test misses the planted defect at
360, 390 and 414 and catches it only at 768. The layout viewport is the
denominator.

WHAT THE EXEMPTIONS ARE WORTH, measured on the committed fixtures:

  carousel cards under overflow-x:auto      5 findings suppressed, all correct
  transparent click-catcher over body text  1 sample source suppressed
  descendants of an already-flagged element 16 rows collapsed to 1 on the
                                            overflow fixture
  a clipping ancestor, which stops the      1, and this one was found on a real
  page scrolling just as a rail does        third-party page rather than on a
                                            fixture

Without them the clean page reports 6 defects and has none.

WHAT FOUR REAL PAGES SAID, at 390, none of them written here:

  MDN, CSS overflow     605 els   26 text   0 findings
  Wikipedia, mobile     255 els   69 text   1 finding   (43 control labels exempt)
  nodejs.org, fs docs  4000 els   46 text  34 findings  (1 doc-scroll + 33 culprits
                                                         across 4 selectors)
  a bot interstitial      3 els    0 text   0 findings, both text codes n/a

The nodejs one is a REAL defect and it is the strongest evidence for the
denominator argument above, because nobody here authored the page: at 390 it
reports innerWidth 716, scrollWidth 716, clientWidth 390. The obvious test says
false; the page scrolls 326px sideways.

EVERY EXEMPTION IN THIS GATE WAS FOUND BY A PAGE NOBODY HERE WROTE. A fixture is
written by the same hand as the check, so it can only contain shapes that
already occurred to that hand:

  a clipping ancestor absorbs the scroll   MDN, a 534px demo iframe inside an
                                           overflow-x:hidden code example, on a
                                           page that does not scroll. Reported
                                           with the note "nothing to absorb it"
                                           while something plainly had.
  text in a control is an accessible name  Wikipedia, 23 of 25 findings were
                                           "Search" / "Watch" / "Edit" labels
                                           clipped away inside 44x44 buttons.
  a pinned bar covers what you scroll      the clean control itself, once it grew
  beneath it                               tall enough to scroll: its own fixed
                                           header covers the h1 at scrollY 64.

FOUR PAGES IS NOT A RATE. It proves the gate can run real HTML without crying
wolf, and says nothing about precision across a corpus. Collect real runs before
anyone promotes this past advisory.`);
}

function readSnapshots() {
    const dir = val('--dir', null);
    const files = [];
    if (dir) {
        if (!fs.existsSync(dir)) { console.error(`No such directory: ${dir}`); process.exit(2); }
        for (const f of fs.readdirSync(dir).sort()) {
            if (f.endsWith('.json')) files.push(path.join(dir, f));
        }
    }
    for (const a of argv) {
        if (!a.startsWith('--') && a.endsWith('.json')) files.push(a);
    }
    return files;
}

function thresholdOverrides() {
    const out = {};
    for (const k of Object.keys(CHECKS.DEFAULTS)) {
        const v = val(`--${k}`, null);
        if (v != null && !Number.isNaN(Number(v))) out[k] = Number(v);
    }
    return out;
}

/**
 * Known-positive control. It proves the analyzer can SEE before any run is
 * allowed to report an absence, and it runs off the committed real-browser
 * fixtures rather than off hand-written objects: a snapshot invented here would
 * only ever confirm this file's own model of what a browser returns.
 */
function selftest() {
    const dir = path.resolve(__dirname, '..', '..', '..', 'tooling', 'fixtures', 'layout', 'snapshots');
    if (!fs.existsSync(dir)) {
        console.log('SELFTEST SKIPPED - fixtures are not installed beside this script.');
        console.log('They live in the source repo at tooling/fixtures/layout/snapshots.');
        return 0;
    }
    const load = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
    let bad = 0;
    const say = (ok, msg) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

    const over = CHECKS.analyse(load('defect-overflow-390.json'));
    say(over.status === 'MEASURED', 'the overflow fixture is measurable');
    say(over.counts && over.counts.docScroll === 1, 'it reports the document scrolling sideways');
    say(over.counts && over.counts.overflowCulprit === 1, 'and names exactly one culprit');

    const occ = CHECKS.analyse(load('defect-occlusion-390.json'));
    say(occ.counts && occ.counts.occluded === 1, 'the occlusion fixture reports one covered text run');

    const clip = CHECKS.analyse(load('defect-clip-390.json'));
    say(clip.counts && clip.counts.clippedText === 3, 'the clipping fixture reports three cut-off runs');

    const clean = CHECKS.analyse(load('clean-390.json'));
    say(clean.status === 'MEASURED', 'the clean control is measurable');
    say(clean.findings.length === 0, 'and reports nothing');
    say(clean.counts.exempt.scrollerAbsorbed > 0, 'having suppressed real carousel-card overflow');

    const blind = CHECKS.analyse(Object.assign(load('clean-390.json'), { elements: [] }));
    say(blind.status === 'UNMEASURED', 'an empty harvest refuses rather than passing');

    console.log(`\n${bad ? 'SELFTEST FAILED' : 'SELFTEST PASSED'} - 9 assertions over 5 real-browser snapshots.`);
    return bad ? 1 : 0;
}

function report(results, opts) {
    const s = CHECKS.summarise(results);
    const out = [];
    const first = results.find((r) => r.viewport);
    out.push('rendered-layout gate - ADVISORY' + (opts.strict ? ' (--strict: findings will exit 1)' : ''));
    if (first) {
        out.push(`page:     ${first.viewport.url}`);
        out.push(`captured: ${first.viewport.capturedAt}  probe ${results.find((r) => r.viewport) ? (results.find((r) => r.probeSha) || {}).probeSha || 'unstamped' : '?'}`);
        // A browser that reports one user agent under 768 and another above it
        // is EMULATING a phone, and every geometry number below 768 comes from
        // a different font rasteriser than the ones above it. A gate that
        // printed one UA would hide that. Listed per width when they disagree.
        const uas = new Map();
        for (const r of results) {
            if (!r.viewport) continue;
            const key = r.viewport.userAgent;
            if (!uas.has(key)) uas.set(key, new Set());
            uas.get(key).add(r.width);
        }
        if (uas.size === 1) {
            out.push(`browser:  ${[...uas.keys()][0]}`);
        } else {
            out.push('browser:  differs by width -');
            for (const [ua, widths] of uas) out.push(`          ${[...widths].sort((a, b) => a - b).join(', ')}: ${ua}`);
        }
    }
    out.push('');

    // The population line. A bare verdict is indistinguishable from a finder
    // that returned nothing, so every row says what it looked at.
    out.push('width  status      elements  text  findings  doc  culprit  clip  occluded');
    for (const r of s.byWidth) {
        if (r.status !== 'MEASURED') {
            out.push(`${String(r.width).padEnd(6)} ${r.status.padEnd(11)} ${r.reason}`);
            continue;
        }
        const c = r.counts;
        // A text-based count is null when no text was sampled at all. It prints
        // n/a rather than 0, because a zero from a check with nothing to look
        // at is a claim about the probe, not about the page.
        const n = (v) => (v === null || v === undefined ? 'n/a' : String(v));
        out.push(
            String(r.width).padEnd(6) + ' ' +
            'MEASURED'.padEnd(11) + ' ' +
            String(r.elements).padStart(8) + '  ' +
            String(r.textSampled).padStart(4) + '  ' +
            String(c.total).padStart(8) + '  ' +
            String(c.docScroll).padStart(3) + '  ' +
            String(c.overflowCulprit).padStart(7) + '  ' +
            n(c.clippedText).padStart(4) + '  ' +
            n(c.occluded).padStart(8)
        );
    }
    out.push('');
    out.push(`${s.measured} of ${s.widths} widths measured, ${s.refused} refused. ` +
        `${s.elementsScanned} element boxes and ${s.textSampled} text runs scanned. ` +
        `${s.totalFindings} findings.`);

    // A code fired at some widths and not others IS the responsive finding, so
    // it gets its own line rather than being inferred from the table.
    const responsive = Object.entries(s.widthsByCode).filter(([, w]) => w.length && w.length < s.measured);
    if (responsive.length) {
        out.push('');
        out.push('Width-dependent:');
        for (const [code, widths] of responsive) {
            const clean = s.byWidth.filter((r) => r.status === 'MEASURED' && !widths.includes(r.width)).map((r) => r.width);
            out.push(`  ${code}  present at ${widths.join(', ')} - absent at ${clean.join(', ')}`);
        }
    }

    if (!opts.quiet) {
        for (const r of results) {
            if (r.status !== 'MEASURED' || !r.findings.length) continue;
            out.push('');
            out.push(`--- ${r.width}px`);
            // Collapsed by selector shape. `[measured 2026-09-03]` nodejs.org's
            // fs docs at 390 produce 33 OVERFLOW-CULPRIT rows across FOUR
            // distinct selectors - one row per list item, all saying the same
            // thing, and the DOC-SCROLL line that matters scrolls off the top.
            // The count and the worst case carry everything the 33 rows did.
            const groups = new Map();
            for (const f of r.findings) {
                const key = f.code + ' ' + f.sel;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(f);
            }
            for (const [, fs_] of groups) {
                const f = fs_[0];
                const times = fs_.length > 1 ? `   x${fs_.length}` : '';
                out.push(`  ${f.code}  ${f.sel}${times}`);
                if (fs_.length > 1 && f.detail.overshootPx !== undefined) {
                    const worst = Math.max(...fs_.map((x) => x.detail.overshootPx));
                    out.push(`      ${fs_.length} elements match this selector; worst extends ${Math.round(worst)}px past the layout viewport`);
                } else {
                    out.push(`      ${f.note}`);
                }
                out.push(`      threshold: ${f.threshold}`);
                if (f.code === CHECKS.CODES.DOC_SCROLL && f.detail.naiveTestWouldMiss) {
                    out.push('      note: scrollWidth > innerWidth is FALSE here. The visual viewport ' +
                        `zoomed to ${f.detail.innerWidth} to fit; only the layout viewport (${f.detail.clientWidth}) sees this.`);
                }
            }
            if (groups.size < r.findings.length) {
                out.push(`  (${r.findings.length} findings collapsed to ${groups.size} distinct selectors)`);
            }
        }
        const ex = results.filter((r) => r.counts).reduce((a, r) => {
            for (const [k, v] of Object.entries(r.counts.exempt)) a[k] = (a[k] || 0) + v;
            return a;
        }, {});
        const shown = Object.entries(ex).filter(([, v]) => v > 0);
        if (shown.length) {
            out.push('');
            out.push('Suppressed as correct-by-design: ' + shown.map(([k, v]) => `${k}=${v}`).join(', '));
        }
        const t = results.find((r) => r.thresholds);
        if (t) out.push('Thresholds: ' + JSON.stringify(t.thresholds));
    }
    return out.join('\n');
}

function main() {
    if (has('--help') || has('-h')) { usage(); return 0; }
    if (has('--how')) { how(); return 0; }
    if (has('--print-probe')) {
        const w = Number(val('--width', 0)) || null;
        console.log(PROBE.probeSource({ requestedWidth: w, scrollSteps: Number(val('--scroll-steps', 3)) || 3 }));
        return 0;
    }
    if (has('--selftest')) return selftest();

    const files = readSnapshots();
    if (!files.length) { usage(); console.error('\nNo snapshots given. See --how.'); return 2; }

    const opts = { strict: has('--strict'), quiet: has('--quiet') };
    const T = thresholdOverrides();
    const results = [];
    for (const f of files) {
        let snap;
        try { snap = JSON.parse(fs.readFileSync(f, 'utf8')); }
        catch (e) {
            results.push(CHECKS.analyse(null, T));
            console.error(`could not read ${f}: ${e.message}`);
            continue;
        }
        results.push(CHECKS.analyse(snap, T));
    }
    results.sort((a, b) => (a.width || 0) - (b.width || 0));

    // One report per PAGE. A directory of snapshots routinely holds several
    // pages, and merging them produces a table with four rows labelled 360 and
    // a header naming whichever page happened to sort first.
    const pages = new Map();
    for (const r of results) {
        const key = (r.viewport && r.viewport.url) || 'unknown';
        if (!pages.has(key)) pages.set(key, []);
        pages.get(key).push(r);
    }

    if (has('--json')) {
        console.log(JSON.stringify({
            pages: [...pages].map(([url, rs]) => ({ url, summary: CHECKS.summarise(rs), results: rs })),
        }, null, 2));
    } else {
        const blocks = [...pages.values()].map((rs) => report(rs, opts));
        const rule = '\n\n' + '='.repeat(78) + '\n\n';
        console.log(blocks.join(rule));
        if (pages.size > 1) {
            console.log('\n' + `${pages.size} pages, ${results.length} snapshots, ` +
                `${results.reduce((n, r) => n + r.findings.length, 0)} findings, ` +
                `${results.filter((r) => r.status !== 'MEASURED').length} refused.`);
        }
    }

    const findings = results.reduce((n, r) => n + r.findings.length, 0);
    const refused = results.filter((r) => r.status !== 'MEASURED').length;
    if (opts.strict && (findings || refused)) return 1;
    return 0;
}

if (require.main === module) process.exit(main());

module.exports = { report, selftest };
