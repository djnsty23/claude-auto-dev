#!/usr/bin/env node
'use strict';
/**
 * mistake-recurrence.js: does a mistake class stop once a rule or a detector
 * claims to prevent it?
 *
 * WHY. Every retry that costs something gets a one-line rule and an incident in
 * the lessons skill. Nothing measured whether the rule worked. A class whose
 * incidents keep arriving after its rule landed is a class the rule does not
 * prevent, and prose that a reader agrees with and then violates is not a
 * control. This script turns the lessons files into a dated incident table and
 * reads each class's prevention date from git, so "did the rule work" becomes a
 * number.
 *
 * WHAT IT READS.
 *   --lessons <dir>    the lessons references, one incident per unit (below)
 *   --mirror <repo>    the git mirror of the rules and lessons. A rule anchor is
 *                      dated by the first commit that ADDED a matching line.
 *   --code-repo <repo> where detector anchors live (default: this repo)
 *   --catalog <json>   the classes, their matchers and prevention anchors
 *                      (default: tooling/mistake-classes.json beside this file)
 *   --repo <repo>      a product repo whose rework fixes join as incidents,
 *                      through mine-fixes --json --records (repeatable)
 *   --now YYYY-MM-DD   the last day an incident date may carry (default today)
 *   --grace <days>     days after the prevention day that still count as
 *                      before (default 1, see THE RATE)
 * Defaults for --lessons and --mirror come from claude-paths.js, so no path in
 * here is one machine's.
 *
 * A UNIT is a `##` to `####` heading, a numbered rule entry (`10d. **...**`), or
 * a table row whose first cell is bold text. Its dates are every YYYY-MM-DD in
 * it, minus `[stated ...]` tags, lines that say the text was moved, future
 * dates, and dates that are part of a file name. A table row with no date of
 * its own inherits its heading's. A unit is classified by its title first, and
 * by its first paragraphs only when the title matches nothing. The catalog's
 * overrides win over both. A file preamble and a unit whose title says it holds
 * moved rule text are excluded, and counted.
 *
 * AN INCIDENT is a class-day: a class and a date on which at least one unit of
 * that class is dated. Two units about one incident on one day count once. Two
 * real incidents of one class on one day also count once, so the counts are
 * floors.
 *
 * THE RATE is incident-days AFTER the class's first prevention date divided by
 * incident-days ON OR BEFORE it. The prevention day itself counts as before,
 * because a rule usually lands the day its triggering incident happened, and a
 * one-day date cannot order the two. So do the --grace days after it (default
 * 1): the mirror dates a rule by its sync commit and the lessons file dates the
 * incident by when it was written up, and the two disagree by a day in both
 * directions (a rule committed 07-04 13:44 +03:00 whose incident says 07-05).
 * Pass --grace 0 for the strict split. Lessons incidents and fix commits are
 * counted and rated SEPARATELY: they are different populations, and a product
 * repo's fix volume follows its commit volume, not anyone's learning.
 *
 * Exit 0 when the table was computed. Exit 2 when an input cannot be read: a
 * missing lessons dir or one with no .md file, a mirror that is not a git repo,
 * a catalog that does not parse, or a --repo that mine-fixes cannot read. The
 * population prints on every run that gets that far.
 *
 * Usage:
 *   node tooling/mistake-recurrence.js [--lessons <dir>] [--mirror <repo>] [--repo <repo>]... [--json] [--units]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, '..');
const MINE_FIXES = path.join(REPO_ROOT, 'plugins', 'autodev-core', 'scripts', 'mine-fixes.js');
const PATHS = require(path.join(REPO_ROOT, 'plugins', 'autodev-core', 'scripts', 'claude-paths.js'));

const USAGE = 'usage: node tooling/mistake-recurrence.js [--lessons <dir>] [--mirror <repo>] [--code-repo <repo>]\n'
    + '         [--catalog <json>] [--repo <repo>]... [--now YYYY-MM-DD] [--grace <days>] [--json] [--units]\n'
    + 'Recurrence per mistake class: incident-days after its first rule or detector, over incident-days before.\n'
    + '  --lessons    the lessons references dir (default <config dir>/skills/lessons/references)\n'
    + '  --mirror     the git mirror of rules and lessons (default the fleet memory checkout)\n'
    + '  --code-repo  the repo detector anchors are dated in (default this repo)\n'
    + '  --catalog    the class catalog (default tooling/mistake-classes.json)\n'
    + '  --repo       a product repo whose rework fixes join as incidents (repeatable)\n'
    + '  --now        the latest valid incident date (default today)\n'
    + '  --grace      days after the prevention day that still count as before (default 1)\n'
    + '  --units      print every unit with its dates and classes\n'
    + '  --json       print one JSON object\n'
    + 'Exit 0 computed, 2 an input could not be read.';

function parseArgs(argv) {
    const o = { lessons: null, mirror: null, codeRepo: REPO_ROOT, catalog: path.join(HERE, 'mistake-classes.json'),
        repos: [], now: null, grace: 1, json: false, units: false, help: false, error: null };
    const VALUED = ['--lessons', '--mirror', '--code-repo', '--catalog', '--repo', '--now', '--grace'];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') o.help = true;
        else if (a === '--json') o.json = true;
        else if (a === '--units') o.units = true;
        else if (VALUED.includes(a)) {
            const v = argv[i + 1];
            if (v === undefined || v.startsWith('--')) { o.error = a + ' needs a value'; return o; }
            i++;
            if (a === '--lessons') o.lessons = v;
            else if (a === '--mirror') o.mirror = v;
            else if (a === '--code-repo') o.codeRepo = v;
            else if (a === '--catalog') o.catalog = v;
            else if (a === '--repo') o.repos.push(v);
            else if (a === '--grace') {
                if (!/^\d{1,2}$/.test(v)) { o.error = '--grace must be a whole number of days, got ' + v; return o; }
                o.grace = Number(v);
            } else o.now = v;
        } else { o.error = 'unknown argument: ' + a; return o; }
    }
    if (o.now !== null && !/^\d{4}-\d{2}-\d{2}$/.test(o.now)) o.error = '--now must be YYYY-MM-DD, got ' + o.now;
    return o;
}

function localDay(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function addDays(day, n) {
    const t = new Date(day + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
}

// ---- The catalog -----------------------------------------------------------

function loadCatalog(file) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        return { error: 'catalog ' + file + ' could not be read: ' + e.message };
    }
    if (!raw || !Array.isArray(raw.classes) || raw.classes.length === 0) return { error: 'catalog ' + file + ' has no classes' };
    const ids = new Set();
    const classes = [];
    for (const c of raw.classes) {
        if (!c.id || ids.has(c.id)) return { error: 'catalog class id missing or repeated: ' + c.id };
        ids.add(c.id);
        let match;
        try { match = (c.match || []).map((s) => new RegExp(s, 'i')); } catch (e) {
            return { error: 'catalog class ' + c.id + ' has a bad matcher: ' + e.message };
        }
        // A pattern holding a control character is an escape that was mangled
        // on its way into the file: `\\b` written through a shell heredoc
        // arrives as `\b`, which JSON reads as a backspace, and the pattern
        // then matches nothing while the table still prints. Refuse it.
        const mangled = [...(c.match || []), ...(c.anchors || []).map((a) => a.re || '')].find((s) => /[\x00-\x1f]/.test(s));
        if (mangled !== undefined) return { error: 'catalog class ' + c.id + ' has a pattern with a control character, a mangled escape: ' + JSON.stringify(mangled) };
        const anchors = [];
        for (const a of c.anchors || []) {
            let re = null;
            try { re = a.re ? new RegExp(a.re, 'i') : null; } catch (e) {
                return { error: 'catalog class ' + c.id + ' has a bad anchor pattern: ' + e.message };
            }
            const paths = Array.isArray(a.path) ? a.path : [a.path];
            if (!paths.length || paths.some((p) => typeof p !== 'string' || !p)) return { error: 'catalog class ' + c.id + ' has an anchor with no path' };
            for (const p of paths) anchors.push({ kind: a.kind === 'detector' ? 'detector' : 'rule', repo: a.repo === 'code' ? 'code' : 'mirror', path: p, re });
        }
        classes.push({ id: c.id, name: c.name || c.id, definition: c.definition || '', match, anchors,
            mineFixes: Array.isArray(c.mineFixes) ? c.mineFixes : [] });
    }
    const overrides = [];
    for (const [key, val] of Object.entries(raw.overrides || {})) {
        const hash = key.indexOf('#');
        if (hash < 1 || !Array.isArray(val)) return { error: 'catalog override must be "<file>#<title prefix>": [ids], got ' + key };
        for (const id of val) if (!ids.has(id)) return { error: 'catalog override ' + key + ' names an unknown class ' + id };
        overrides.push({ file: key.slice(0, hash), prefix: key.slice(hash + 1).toLowerCase(), ids: val, used: 0 });
    }
    return { classes, overrides, excludeFiles: Array.isArray(raw.excludeFiles) ? raw.excludeFiles : [] };
}

// ---- Units and their dates -------------------------------------------------

// A date that is not glued to a file name or an identifier. `2026-08-19/20` is
// a two-day range and yields both days.
const DATE = /(^|[^A-Za-z0-9_/-])(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:\/(0[1-9]|[12]\d|3[01]))?(?![A-Za-z0-9_-]|\.[A-Za-z])/g;
const MOVED_LINE = /\bmoved\b/i;
const MOVED_TITLE = /(^moved\b|\bmoved (from|out of|here)\b|\(moved\b)/i;

function datesIn(lines, now) {
    const out = new Set();
    for (const line of lines) {
        if (MOVED_LINE.test(line)) continue;
        const text = line.replace(/\[(stated|reported)\s+[0-9-]+\]/gi, '');
        DATE.lastIndex = 0;
        let m;
        while ((m = DATE.exec(text))) {
            for (const day of [m[4], m[5]]) {
                if (!day) continue;
                const d = m[2] + '-' + m[3] + '-' + day;
                if (d >= '2025-01-01' && d <= now) out.add(d);
            }
        }
    }
    return out;
}

function readUnits(dir, excludeFiles, now) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    const read = files.filter((f) => !excludeFiles.includes(f));
    const units = [];
    for (const f of read) {
        const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
        let fence = false;
        let heading = null;
        let cur = { file: f, title: '(preamble)', kind: 'preamble', body: [], parent: null };
        for (const line of lines) {
            if (/^\s*(```|~~~)/.test(line)) { fence = !fence; cur.body.push(line); continue; }
            let m;
            if (!fence && (m = line.match(/^#{2,4}\s+(.*\S)\s*$/))) {
                units.push(cur);
                cur = { file: f, title: m[1], kind: 'heading', body: [], parent: null };
                heading = cur;
                continue;
            }
            if (!fence && (m = line.match(/^(\d+[a-z]?(?:-[ivx]+)?)\.\s+\*\*(.+?)\*\*/))) {
                units.push(cur);
                cur = { file: f, title: m[1] + '. ' + m[2], kind: 'rule-entry', body: [line], parent: null };
                continue;
            }
            if (!fence && (m = line.match(/^\|\s*\*\*([^*0-9][^*]*)\*\*/))) {
                units.push(cur);
                cur = { file: f, title: m[1], kind: 'table-row', body: [line], parent: heading };
                continue;
            }
            cur.body.push(line);
        }
        units.push(cur);
    }
    for (const u of units) u.dates = datesIn([u.title, ...u.body], now);
    for (const u of units) if (u.kind === 'table-row' && u.dates.size === 0 && u.parent) u.dates = new Set(u.parent.dates);
    return { files, read, units };
}

function leadOf(u) {
    // The first paragraphs, stopped at 700 characters: enough to name the
    // subject of a unit whose title is a rule id, short enough not to drag in
    // every topic a long section later touches.
    return u.body.join('\n').replace(/```[\s\S]*?```/g, ' ').trim().slice(0, 700);
}

function classify(units, catalog) {
    for (const u of units) {
        u.classes = [];
        u.via = null;
        u.excluded = null;
        if (u.kind === 'preamble') { u.excluded = 'preamble'; continue; }
        if (MOVED_TITLE.test(u.title)) { u.excluded = 'moved rule text'; continue; }
        const ov = catalog.overrides.find((o) => o.file === u.file && u.title.toLowerCase().startsWith(o.prefix));
        if (ov) { ov.used++; u.classes = ov.ids.slice(); u.via = 'override'; continue; }
        const byTitle = catalog.classes.filter((c) => c.match.some((re) => re.test(u.title))).map((c) => c.id);
        if (byTitle.length) { u.classes = byTitle; u.via = 'title'; continue; }
        const lead = leadOf(u);
        const byLead = catalog.classes.filter((c) => c.match.some((re) => re.test(lead))).map((c) => c.id);
        if (byLead.length) { u.classes = byLead; u.via = 'lead'; }
    }
}

// ---- Prevention dates from git --------------------------------------------

function git(repo, args) {
    return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, windowsHide: true });
}

function isGitRepo(repo) {
    if (!repo) return false;
    const r = git(repo, ['rev-parse', '--git-dir']);
    return !r.error && r.status === 0;
}

/**
 * The first commit that ADDED a line matching each anchor, from one patch walk
 * over the anchors' paths. An anchor with no pattern is dated by the first
 * commit that touched its path at all.
 */
function datePreventions(repo, anchors) {
    const out = new Map();
    if (!anchors.length) return { out };
    const paths = [...new Set(anchors.map((a) => a.path))];
    const r = git(repo, ['log', '--reverse', '--no-color', '--no-ext-diff', '--format=%x00%H%x01%cI', '-p', '--unified=0', '--', ...paths]);
    if (r.error || r.status !== 0) return { error: 'git log failed in ' + repo + ': ' + ((r.stderr || '').trim() || (r.error && r.error.message) || 'exit ' + r.status) };
    const root = git(repo, ['log', '--reverse', '--format=%cI', '--max-parents=0']);
    const rootDay = root.status === 0 ? (root.stdout.split('\n')[0] || '').slice(0, 10) : null;
    const pending = new Set(anchors);
    for (const rec of r.stdout.split('\x00')) {
        if (!pending.size) break;
        if (!rec.trim()) continue;
        const nl = rec.indexOf('\n');
        const head = (nl < 0 ? rec : rec.slice(0, nl)).split('\x01');
        const hash = head[0];
        const day = (head[1] || '').slice(0, 10);
        let file = null;
        for (const line of (nl < 0 ? '' : rec.slice(nl + 1)).split('\n')) {
            if (line.startsWith('+++ ')) { file = line.startsWith('+++ b/') ? line.slice(6) : null; continue; }
            if (!file) continue;
            for (const a of [...pending]) {
                if (a.path !== file && !file.startsWith(a.path.replace(/\/?$/, '/'))) continue;
                if (!a.re || (line.startsWith('+') && a.re.test(line.slice(1)))) {
                    out.set(a, { day, hash: hash.slice(0, 8), predatesHistory: day === rootDay, line: a.re ? line.slice(1).trim().slice(0, 140) : null });
                    pending.delete(a);
                }
            }
        }
    }
    return { out };
}

/** Where the anchor's pattern sits in the file today, and any [stated] tag on that line. */
function currentLine(repo, a) {
    let text;
    try { text = fs.readFileSync(path.join(repo, a.path), 'utf8'); } catch { return { where: a.path + ' (not on disk)', stated: null }; }
    if (!a.re) return { where: a.path, stated: null };
    const lines = text.split(/\r?\n/);
    const i = lines.findIndex((l) => a.re.test(l));
    if (i < 0) return { where: a.path + ' (pattern gone)', stated: null };
    const st = lines[i].match(/\[stated (\d{4}-\d{2}-\d{2})\]/);
    return { where: a.path + ':' + (i + 1), stated: st ? st[1] : null };
}

// ---- Fix commits from mine-fixes ------------------------------------------

function readFixRecords(repo) {
    const r = spawnSync(process.execPath, [MINE_FIXES, repo, '--json', '--records'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    if (r.error || r.status !== 0) return { error: 'mine-fixes could not read ' + repo + ': ' + ((r.stderr || '').trim() || 'exit ' + r.status) };
    let j;
    try { j = JSON.parse(r.stdout); } catch { return { error: 'mine-fixes printed no JSON for ' + repo }; }
    if (j.error) return { records: [], fixes: 0, note: j.error };
    if (!Array.isArray(j.records)) return { error: 'mine-fixes returned no records for ' + repo + ' (a mine-fixes without --records)' };
    return { records: j.records, fixes: j.fixes };
}

// ---- The table -------------------------------------------------------------

function rate(after, before) {
    if (before === 0) return after === 0 ? null : Infinity;
    return after / before;
}

function fmtRate(r) {
    if (r === null) return '-';
    if (r === Infinity) return 'inf';
    return r.toFixed(2);
}

function buildRow(c, units, fixRepos, dated, repoOf, grace) {
    const lessonDays = new Set();
    const unitsOf = units.filter((u) => !u.excluded && u.classes.includes(c.id));
    for (const u of unitsOf) for (const d of u.dates) lessonDays.add(d);
    const fixDays = new Set();
    let fixRecords = 0;
    for (const fr of fixRepos) {
        for (const rec of fr.records) {
            if ((rec.classes || []).some((n) => c.mineFixes.includes(n))) { fixDays.add(fr.repo + '|' + rec.date); fixRecords++; }
        }
    }
    const prevs = c.anchors.map((a) => {
        const d = dated.get(a);
        const cur = currentLine(repoOf(a), a);
        let day = d ? d.day : null;
        let source = d ? 'git ' + d.hash : null;
        if (cur.stated && (!day || cur.stated < day)) { day = cur.stated; source = 'stated'; }
        return { kind: a.kind, repo: a.repo, where: cur.where, day, source, predatesHistory: !!(d && d.predatesHistory && source !== 'stated'), firstLine: d ? d.line : null };
    });
    const withDay = prevs.filter((p) => p.day).sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
    const first = withDay[0] || null;
    const pday = first ? first.day : null;
    const lastBefore = pday ? addDays(pday, grace) : null;
    const split = (days, keyed) => {
        let before = 0, after = 0;
        for (const d of days) {
            const day = keyed ? d.split('|')[1] : d;
            if (day > lastBefore) after++; else before++;
        }
        return { before, after };
    };
    const L = pday ? split(lessonDays, false) : null;
    const F = pday ? split(fixDays, true) : null;
    const kinds = [...new Set(withDay.map((p) => p.kind))].sort();
    const firstDetector = withDay.find((p) => p.kind === 'detector') || null;
    return {
        id: c.id, name: c.name, definition: c.definition,
        units: unitsOf.length,
        lessonDays: [...lessonDays].sort(),
        prevention: first ? { day: first.day, lastBefore, kind: first.kind, where: first.where, source: first.source, predatesHistory: first.predatesHistory } : null,
        preventionKinds: kinds.length ? kinds.join('+') : 'none',
        firstDetectorDay: firstDetector ? firstDetector.day : null,
        anchors: prevs,
        lessons: { total: lessonDays.size, before: L ? L.before : null, after: L ? L.after : null, rate: L ? rate(L.after, L.before) : null },
        fixes: { records: fixRecords, days: fixDays.size, before: F ? F.before : null, after: F ? F.after : null, rate: F ? rate(F.after, F.before) : null },
        recurred: !!(L && L.after > 0),
    };
}

function render(pop, rows, recurring, units, fixRepos, showUnits) {
    const out = [];
    out.push('POPULATION (as of ' + pop.now + ')');
    out.push('  lessons files: ' + pop.filesRead + ' read of ' + pop.filesFound + (pop.filesExcluded.length ? ' (excluded by the catalog: ' + pop.filesExcluded.join(', ') + ')' : ''));
    out.push('  units: ' + pop.units + ', of which ' + pop.excludedPreamble + ' file preambles and ' + pop.excludedMoved + ' moved-rule-text units are excluded');
    out.push('  remaining units: ' + pop.dated + ' dated, ' + pop.undated + ' undated (excluded: no date to place them)');
    out.push('  dated units: ' + pop.datedClassified + ' classified, ' + pop.datedUnclassified + ' unclassified, ' + pop.datedOverriddenToNone + ' overridden to no class');
    out.push('  incident-days (class x day): ' + pop.lessonIncidentDays + ' from ' + pop.unitDatePairs + ' classified unit-date pairs');
    out.push('  classes: ' + pop.classes + ', ' + pop.classesWithIncidents + ' with an incident, ' + pop.classesWithPrevention + ' with a prevention date'
        + (pop.preventionPredatesHistory ? ' (' + pop.preventionPredatesHistory + ' dated to the first mirror commit, marked *, meaning on or before)' : ''));
    if (fixRepos.length) {
        out.push('  fix commits: ' + pop.fixRepos.map((f) => f.repo + ' ' + f.reworkRecords + ' rework of ' + f.fixes + ' fixes' + (f.note ? ' (' + f.note + ')' : '')).join(', ')
            + '. ' + pop.fixRecordsMapped + ' record-class matches mapped to a class');
    }
    if (pop.overridesUnused.length) out.push('  overrides that matched no unit: ' + pop.overridesUnused.join(', '));
    out.push('');
    out.push('TABLE (lessons incident-days, ' + (pop.grace ? 'the prevention day and the ' + pop.grace + ' day' + (pop.grace > 1 ? 's' : '') + ' after it count' : 'the prevention day counts') + ' as before)');
    out.push('  ' + 'id'.padEnd(26) + 'before'.padStart(7) + 'after'.padStart(6) + 'rate'.padStart(6) + '  ' + 'kind'.padEnd(14) + 'prevented'.padEnd(12) + 'first anchor');
    for (const r of rows) {
        const p = r.prevention;
        out.push('  ' + r.id.padEnd(26)
            + String(p ? r.lessons.before : r.lessons.total).padStart(7)
            + String(p ? r.lessons.after : '-').padStart(6)
            + fmtRate(r.lessons.rate).padStart(6) + '  '
            + r.preventionKinds.padEnd(14)
            + (p ? p.day + (p.predatesHistory ? '*' : '') : 'none').padEnd(12)
            + (p ? p.where : 'none'));
    }
    if (fixRepos.length) {
        out.push('');
        out.push('FIX COMMITS (rework fixes mapped through mine-fixes classes, counted as repo-days)');
        for (const r of rows.filter((x) => x.fixes.records)) {
            out.push('  ' + r.id.padEnd(26) + String(r.fixes.before === null ? r.fixes.days : r.fixes.before).padStart(7)
                + String(r.fixes.after === null ? '-' : r.fixes.after).padStart(6) + fmtRate(r.fixes.rate).padStart(6) + '  from ' + r.fixes.records + ' records');
        }
    }
    out.push('');
    out.push('RECURRED AFTER PREVENTION: ' + recurring.length + ' of ' + pop.classesWithPrevention + ' prevented classes');
    for (const r of recurring) {
        out.push('  ' + r.id + ': ' + r.lessons.after + ' after, ' + r.lessons.before + ' before, prevention ' + r.preventionKinds + ' since ' + r.prevention.day
            + ', after-days ' + r.lessonDays.filter((d) => d > r.prevention.lastBefore).join(' '));
    }
    if (showUnits) {
        out.push('');
        out.push('UNITS');
        for (const u of units) {
            const cls = u.excluded ? '[' + u.excluded + ']' : (u.classes.join(',') || '-') + (u.via ? ' (' + u.via + ')' : '');
            out.push('  ' + u.file.replace(/\.md$/, '').padEnd(26) + ' ' + cls.padEnd(40) + ' ' + [...u.dates].sort().join(',').padEnd(24) + ' ' + u.title.slice(0, 90));
        }
    }
    return out.join('\n');
}

function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.help) { console.log(USAGE); return 0; }
    if (o.error) { console.error(o.error + '\n' + USAGE); return 2; }
    const now = o.now || localDay(new Date());
    const lessons = o.lessons || path.join(PATHS.configDir(), 'skills', 'lessons', 'references');
    const mirror = o.mirror || PATHS.fleetMemoryDir();

    const problems = [];
    const catalog = loadCatalog(o.catalog);
    if (catalog.error) problems.push(catalog.error);
    let lessonFiles = null;
    try { lessonFiles = fs.readdirSync(lessons).filter((f) => f.endsWith('.md')); } catch (e) { problems.push('lessons dir ' + lessons + ' could not be read: ' + (e.code || e.message)); }
    if (lessonFiles && lessonFiles.length === 0) problems.push('lessons dir ' + lessons + ' holds no .md file');
    if (!isGitRepo(mirror)) problems.push('mirror ' + mirror + ' is not a git repository');
    const needsCode = !catalog.error && catalog.classes.some((c) => c.anchors.some((a) => a.repo === 'code'));
    if (needsCode && !isGitRepo(o.codeRepo)) problems.push('code repo ' + o.codeRepo + ' is not a git repository');
    if (problems.length) {
        for (const p of problems) console.error('COULD NOT READ: ' + p);
        console.error('Exit 2: no table, because an input could not be read. This is not a clean result.');
        return 2;
    }

    const { files, read, units } = readUnits(lessons, catalog.excludeFiles, now);
    classify(units, catalog);

    const byRepo = { mirror: [], code: [] };
    for (const c of catalog.classes) for (const a of c.anchors) byRepo[a.repo].push(a);
    const dated = new Map();
    for (const [key, repo] of [['mirror', mirror], ['code', o.codeRepo]]) {
        const d = datePreventions(repo, byRepo[key]);
        if (d.error) { console.error('COULD NOT READ: ' + d.error); return 2; }
        for (const [a, v] of d.out) dated.set(a, v);
    }

    const fixRepos = [];
    for (const repo of o.repos) {
        const fr = readFixRecords(repo);
        if (fr.error) { console.error('COULD NOT READ: ' + fr.error); return 2; }
        fixRepos.push(Object.assign({ repo: path.basename(path.resolve(repo)) }, fr));
    }

    const repoOf = (a) => (a.repo === 'mirror' ? mirror : o.codeRepo);
    const rows = catalog.classes.map((c) => buildRow(c, units, fixRepos, dated, repoOf, o.grace));

    const live = units.filter((u) => !u.excluded);
    const pop = {
        now,
        grace: o.grace,
        lessonsDir: lessons,
        filesFound: files.length,
        filesRead: read.length,
        filesExcluded: files.filter((f) => !read.includes(f)),
        units: units.length,
        excludedPreamble: units.filter((u) => u.excluded === 'preamble').length,
        excludedMoved: units.filter((u) => u.excluded === 'moved rule text').length,
        undated: live.filter((u) => u.dates.size === 0).length,
        dated: live.filter((u) => u.dates.size > 0).length,
        datedClassified: live.filter((u) => u.dates.size > 0 && u.classes.length > 0).length,
        datedUnclassified: live.filter((u) => u.dates.size > 0 && u.classes.length === 0 && u.via !== 'override').length,
        datedOverriddenToNone: live.filter((u) => u.dates.size > 0 && u.via === 'override' && u.classes.length === 0).length,
        unitDatePairs: live.filter((u) => u.classes.length).reduce((n, u) => n + u.dates.size, 0),
        lessonIncidentDays: rows.reduce((n, r) => n + r.lessons.total, 0),
        classes: rows.length,
        classesWithPrevention: rows.filter((r) => r.prevention).length,
        classesWithIncidents: rows.filter((r) => r.lessons.total > 0).length,
        preventionPredatesHistory: rows.filter((r) => r.prevention && r.prevention.predatesHistory).length,
        overridesUnused: catalog.overrides.filter((x) => x.used === 0).map((x) => x.file + '#' + x.prefix),
        fixRepos: fixRepos.map((f) => ({ repo: f.repo, fixes: f.fixes || 0, reworkRecords: f.records.length, note: f.note || null })),
        fixRecordsMapped: rows.reduce((n, r) => n + r.fixes.records, 0),
    };

    const recurring = rows.filter((r) => r.recurred)
        .sort((a, b) => b.lessons.after - a.lessons.after || a.lessons.before - b.lessons.before || (a.id < b.id ? -1 : 1));

    if (o.json) {
        const unitsOut = o.units ? units.map((u) => ({ file: u.file, title: u.title, kind: u.kind, dates: [...u.dates].sort(), classes: u.classes, via: u.via, excluded: u.excluded })) : undefined;
        console.log(JSON.stringify({ population: pop, rows, recurring: recurring.map((r) => r.id), units: unitsOut }, (k, v) => (v === Infinity ? 'inf' : v), 2));
        return 0;
    }
    console.log(render(pop, rows, recurring, units, fixRepos, o.units));
    return 0;
}

process.exitCode = main();
