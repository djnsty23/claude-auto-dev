#!/usr/bin/env node
'use strict';
/**
 * skill-census.js - one row per skill: what it COSTS, and when it last FIRED.
 *
 * WHY THIS IS NOT analyze-skill-invocations.js. That script answers "how many
 * of our skills are reachable at all", and its output is deliberately a set:
 * fired, never-fired, split by channel. That is the right shape for the
 * question it asks and the wrong shape for the question that follows it, which
 * is "so which ones do we retire". Retiring needs a per-skill row with a cost
 * on it, because the case for removing a skill is not that it never fired -- it
 * is that it never fired AND it is charging every session for the privilege.
 *
 * `[measured 2026-09-18]` 6 of 53 user-invocable skills in this plugin fired
 * across 552 transcripts in seven days. The other 47 are not free: every one of
 * them puts its name, description and when_to_use into the skill listing of
 * every session that loads the plugin. That is the number this script exists to
 * put next to the zero.
 *
 * THREE THINGS IT MEASURES, and only the first two are measurements:
 *
 * 1. LISTING BYTES, exact. The listing entry is reconstructed from the same
 *    frontmatter the host reads, so this is a count of real bytes in a real
 *    file, not an estimate.
 *
 * 2. LAST FIRED, exact to the transcript line. Not the file's mtime -- a
 *    transcript written to today can hold an invocation from six days ago, and
 *    mtime would date every skill in it to today. For each match the nearest
 *    PRECEDING "timestamp" field is resolved by binary search over the
 *    timestamp positions in that file. The selftest plants exactly that case.
 *
 * 3. TOKENS, ESTIMATED, and labelled as such everywhere it is printed. There is
 *    no tokenizer here and bytes/4 is a rule of thumb, not a measurement. It is
 *    reported because a byte count does not answer "what does this cost me" for
 *    a reader who budgets in tokens, and omitting it would just move the same
 *    division into that reader's head, undated and unlabelled.
 *
 * THE COST FIGURE IS AN UPPER BOUND, AND `--rendered` IS WHY. A count of bytes
 * in a SKILL.md is what the corpus WOULD charge a host that reads every
 * description, and `[measured 2026-09-18]` no host here does. Reading the skill
 * listing the transcripts actually recorded, across 25 sessions: 459 entries on
 * average and 38 of them carrying a description, ~18,000 bytes of description
 * per listing and exactly 18,002 in 15 of the 25. The other 421 entries are a
 * bare name. Whole plugin bundles -- 44 skills, 38 skills, 36 skills -- get zero
 * description slots in every session measured.
 *
 * So there are two different questions and reading the files answers only one:
 *
 *   node tooling/skill-census.js              what the corpus CONTAINS
 *   node tooling/skill-census.js --rendered   what a session was actually SHOWN
 *
 * The second is the one that predicts firing. `[measured 2026-09-18]` of this
 * plugin's skills, 5 of the 5 the MODEL ever chose held a description slot, and
 * 0 of the 47 that never fired held one. The two skills that fired without a
 * slot fired because a person typed a slash command, which needs no description.
 *
 * Slots are NOT awarded for being used, so do not read the column that way: the
 * two most-invoked skills in the plugin that week (11 invocations each, both
 * typed) held zero slots, while a skill with zero invocations held three. The
 * selection rule is not established here. The correlation with model-initiated
 * firing is, and it is the one a maintainer needs: rewording a description that
 * is never rendered cannot change what the model picks.
 *
 * Exit codes: 0 when the probe worked. 2 when it saw no invocations at all,
 * which is a claim about this probe rather than about the corpus -- if either
 * field name changes, every count silently becomes zero and the report reads as
 * a catastrophic finding rather than as a broken reader.
 *
 * Usage:
 *   node tooling/skill-census.js
 *   node tooling/skill-census.js --days 30
 *   node tooling/skill-census.js --rendered
 *   node tooling/skill-census.js --json
 *   node tooling/skill-census.js --plugin autodev-core
 *   node tooling/skill-census.js --selftest
 *   node tooling/skill-census.js --help
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const has = (n) => args.indexOf(n) >= 0;
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

if (has('--help') || has('-h')) {
    console.log([
        'skill-census.js: one row per skill - listing cost, fire count, last fired.',
        '',
        'Usage: node tooling/skill-census.js [--days N] [--plugin NAME] [--json] [--selftest]',
        '',
        '  --days N       transcript window, default 7',
        '  --plugin NAME  restrict the table to one plugin directory',
        '  --rendered     also read the skill LISTING the transcripts recorded, and',
        '                 report how many sessions were shown each description',
        '  --json         machine-readable, same numbers',
        '  --selftest     planted positive and planted negative, then exit',
        '  --help, -h     this text',
        '',
        'Exits 2 when it counted zero invocations (PROBE BROKEN), 0 otherwise.',
        'Reads files only. Writes nothing outside a temp dir under --selftest.',
    ].join('\n'));
    process.exit(0);
}

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const PLUGINS_DIR = path.resolve(__dirname, '..', 'plugins');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

// ---------------------------------------------------------------- transcripts

/** Byte offsets and values of every ISO timestamp in the text, ascending. */
function timestampIndex(text) {
    const positions = [];
    const values = [];
    const re = /"timestamp"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/g;
    let m;
    while ((m = re.exec(text)) !== null) { positions.push(m.index); values.push(m[1]); }
    return { positions: positions, values: values };
}

/** The last timestamp at or before `at`, or null when the match precedes them all. */
function timestampBefore(idx, at) {
    const p = idx.positions;
    if (!p.length || at < p[0]) return null;
    let lo = 0;
    let hi = p.length - 1;
    let best = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (p[mid] <= at) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return idx.values[best];
}

/**
 * Both channels, with a timestamp on every hit.
 *
 * The two regexes are the ones analyze-skill-invocations.js uses, deliberately
 * unchanged: a census that counted a different population than the script it
 * sits beside would produce two numbers for one question, and the difference
 * would be read as a finding about skills rather than about the readers.
 */
function hitsInText(text) {
    const idx = timestampIndex(text);
    const out = [];
    const model = /"skill"\s*:\s*"([a-zA-Z0-9:_-]+)"/g;
    const typed = /<command-name>\s*\/?([A-Za-z0-9:_-]{1,60})\s*<\/command-name>/g;
    let m;
    while ((m = model.exec(text)) !== null) {
        out.push({ name: m[1], channel: 'model', at: timestampBefore(idx, m.index) });
    }
    while ((m = typed.exec(text)) !== null) {
        out.push({ name: m[1], channel: 'typed', at: timestampBefore(idx, m.index) });
    }
    return out;
}

function bareName(s) {
    const t = String(s || '');
    const i = t.lastIndexOf(':');
    return i >= 0 ? t.slice(i + 1) : t;
}

function walkJsonl(dir, sinceMs) {
    const found = [];
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { stack.push(p); continue; }
            if (!/\.jsonl$/.test(e.name)) continue;
            let st;
            try { st = fs.statSync(p); } catch (err) { continue; }
            if (st.mtimeMs < sinceMs) continue;
            found.push(p);
        }
    }
    return found;
}

// --------------------------------------------------------------- the listing

const LISTING_HEADER = 'The following skills are available for use with the Skill tool';

/**
 * THE SEPARATOR IS TWO CHARACTERS, not a newline, and getting this wrong returns
 * zero for every row while looking like a catastrophic finding.
 *
 * The listing reaches a transcript inside a JSON string, so the line breaks in
 * it are stored ESCAPED: the raw bytes hold a backslash followed by an `n`. A
 * reader that splits the block on /\n/ finds exactly one line, matches nothing,
 * and reports that no skill anywhere has a description. `[measured 2026-09-18]`
 * a first version of this reader did precisely that and printed a clean table of
 * 25 rows of zeroes.
 */
const LISTING_SEP = '\\n';

/**
 * One session's listing: which skills it showed, and which of those it showed
 * WITH a description rather than as a bare name.
 */
function listingInText(text) {
    const i = text.indexOf(LISTING_HEADER);
    if (i < 0) return null;
    const block = text.slice(i, i + 200000);
    const end = block.indexOf(LISTING_SEP + LISTING_SEP, 200);
    const body = end > 0 ? block.slice(0, end) : block;
    const described = [];
    const bare = [];
    for (const line of body.split(LISTING_SEP)) {
        if (!/^- [A-Za-z0-9]/.test(line)) continue;
        const m = /^- ([^:\s]+(?::[^:\s]+)?)(: \S)?/.exec(line);
        if (!m) continue;
        (m[2] ? described : bare).push({ name: m[1], bytes: line.length });
    }
    return { described: described, bare: bare };
}

/** Aggregate the listings across a transcript corpus. */
function renderAudit(files, limit) {
    const slots = new Map();      // bare skill name -> listings that showed its description
    const seen = new Map();       // bare skill name -> listings that showed it at all
    let listings = 0;
    let entriesTotal = 0;
    let describedTotal = 0;
    let describedBytes = 0;
    for (const f of files) {
        if (limit && listings >= limit) break;
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
        const l = listingInText(text);
        if (!l) continue;
        listings++;
        entriesTotal += l.described.length + l.bare.length;
        describedTotal += l.described.length;

        // COUNT EACH SKILL ONCE PER LISTING. The column means "in how many
        // sessions was this description shown", so a skill that appears twice in
        // one listing must not score two. `[measured 2026-09-18]` without this
        // the table printed `design 26/25`, a count larger than its own
        // denominator -- which is the only reason the double-count was noticed at
        // all. Two entries can share a bare name whenever two plugins ship one,
        // and a ratio whose numerator and denominator come from different loops
        // has nothing to stop it exceeding 1.
        const shownHere = new Set();
        const seenHere = new Set();
        for (const d of l.described) {
            describedBytes += d.bytes;
            const n = bareName(d.name);
            if (!shownHere.has(n)) { shownHere.add(n); slots.set(n, (slots.get(n) || 0) + 1); }
            seenHere.add(n);
        }
        for (const b of l.bare) seenHere.add(bareName(b.name));
        for (const n of seenHere) seen.set(n, (seen.get(n) || 0) + 1);
    }
    return {
        listings: listings,
        entriesPerListing: listings ? Math.round(entriesTotal / listings) : 0,
        describedPerListing: listings ? Math.round(describedTotal / listings) : 0,
        describedBytesPerListing: listings ? Math.round(describedBytes / listings) : 0,
        slots: slots,
        seen: seen,
    };
}

// ----------------------------------------------------------------- the corpus

/** One scalar YAML value from frontmatter, quoted or bare, single line. */
function fmValue(fm, key) {
    const re = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm');
    const m = re.exec(fm);
    if (!m) return null;
    let v = m[1].trim();
    const quoted = (v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'");
    if (quoted && v.length >= 2) v = v.slice(1, -1);
    return v.replace(/\\"/g, '"');
}

function readCorpus(pluginsDir, onlyPlugin) {
    const rows = [];
    let plugins = [];
    try { plugins = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory()); }
    catch (e) { return { rows: rows, error: e.message }; }
    for (const p of plugins) {
        if (onlyPlugin && p.name !== onlyPlugin) continue;
        const skillsDir = path.join(pluginsDir, p.name, 'skills');
        let names = [];
        try {
            names = fs.readdirSync(skillsDir, { withFileTypes: true })
                .filter((e) => e.isDirectory()).map((e) => e.name);
        } catch (e) { continue; }
        for (const n of names) {
            const f = path.join(skillsDir, n, 'SKILL.md');
            let body = '';
            try { body = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
            // Frontmatter only. `user-invocable` appearing in prose lower down is
            // discussion of the field, not a declaration of it.
            const fmEnd = body.indexOf('\n---', 4);
            const fm = fmEnd > 0 ? body.slice(0, fmEnd) : body.slice(0, 800);
            const desc = fmValue(fm, 'description') || '';
            const when = fmValue(fm, 'when_to_use') || '';
            const invocable = !/^user-invocable:\s*false/m.test(fm);
            // The listing entry a host builds from this file.
            const entry = '- ' + p.name + ':' + n + ': ' + desc + (when ? ' - ' + when : '');
            rows.push({
                plugin: p.name,
                name: n,
                invocable: invocable,
                descBytes: Buffer.byteLength(desc, 'utf8'),
                whenBytes: Buffer.byteLength(when, 'utf8'),
                listingBytes: Buffer.byteLength(entry, 'utf8'),
                bodyBytes: Buffer.byteLength(body, 'utf8'),
                description: desc,
                whenToUse: when,
            });
        }
    }
    return { rows: rows };
}

// ----------------------------------------------------------------- the census

function census(o) {
    const corpus = readCorpus(o.pluginsDir, o.plugin);
    const byName = new Map();
    for (const r of corpus.rows) {
        r.model = 0;
        r.typed = 0;
        r.lastFired = null;
        byName.set(r.name, r);
    }

    const sinceMs = Date.now() - o.days * 86400000;
    const files = o.files || walkJsonl(o.dir, sinceMs);
    let scanned = 0;
    let unreadable = 0;
    let bytes = 0;
    let totalHits = 0;
    let modelHits = 0;
    let typedHits = 0;

    for (const f of files) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch (e) { unreadable++; continue; }
        scanned++;
        bytes += Buffer.byteLength(text, 'utf8');
        for (const h of hitsInText(text)) {
            totalHits++;
            if (h.channel === 'model') modelHits++; else typedHits++;
            const row = byName.get(bareName(h.name));
            if (!row) continue;
            if (h.channel === 'model') row.model++; else row.typed++;
            if (h.at && (!row.lastFired || h.at > row.lastFired)) row.lastFired = h.at;
        }
    }

    let render = null;
    if (o.rendered) {
        // Newest first: a listing from six days ago describes a plugin set that
        // may since have changed, and the question is what sessions see NOW.
        const ordered = files.slice().sort((a, b) => {
            let am = 0;
            let bm = 0;
            try { am = fs.statSync(a).mtimeMs; } catch (e) { /* unreadable */ }
            try { bm = fs.statSync(b).mtimeMs; } catch (e) { /* unreadable */ }
            return bm - am;
        });
        render = renderAudit(ordered, o.renderLimit || 25);
        for (const r of corpus.rows) {
            r.slots = render.slots.get(r.name) || 0;
            r.listedIn = render.seen.get(r.name) || 0;
        }
    }

    return {
        days: o.days,
        transcripts: scanned,
        unreadable: unreadable,
        megabytes: Math.round(bytes / 1048576 * 10) / 10,
        totalHits: totalHits,
        modelHits: modelHits,
        typedHits: typedHits,
        corpusError: corpus.error || null,
        render: render ? {
            listings: render.listings,
            entriesPerListing: render.entriesPerListing,
            describedPerListing: render.describedPerListing,
            describedBytesPerListing: render.describedBytesPerListing,
        } : null,
        rows: corpus.rows,
    };
}

// ------------------------------------------------------------- the probe guard

/**
 * Has this reader gone blind? Returns the message, or null when it is working.
 *
 * A TOTAL of zero is the obvious case and it was the only case until the suite
 * caught the gap: there are TWO independent readers here, and guarding only
 * their sum means one of them can go blind while the other keeps the total
 * healthy. Rename the invocation field and every `model` column becomes zero
 * while the typed channel carries the total, so the script prints a confident
 * table saying the model never chooses any skill. That is precisely the finding
 * this whole census exists to report, arrived at by not looking.
 *
 * So the asymmetry is the second signal. One channel at zero while the other is
 * well populated is a broken reader, not a corpus fact. The threshold is
 * deliberately loose: a handful of transcripts can legitimately contain no typed
 * command at all, and a guard that fires on those would be muted within a week.
 */
const LOPSIDED_MIN = 20;

function probeVerdict(c) {
    if (c.totalHits === 0) {
        return 'PROBE BROKEN: zero invocations across ' + c.transcripts
            + ' transcript(s). That is a claim about this reader, not about the corpus.';
    }
    if (c.modelHits === 0 && c.typedHits >= LOPSIDED_MIN) {
        return 'PROBE BROKEN: the typed channel saw ' + c.typedHits
            + ' invocation(s) and the model channel saw NONE. One reader is blind;'
            + ' do not read the model column as a finding.';
    }
    if (c.typedHits === 0 && c.modelHits >= LOPSIDED_MIN) {
        return 'PROBE BROKEN: the model channel saw ' + c.modelHits
            + ' invocation(s) and the typed channel saw NONE. One reader is blind;'
            + ' do not read the typed column as a finding.';
    }
    return null;
}

// ------------------------------------------------------------------ reporting

function fmtDate(iso) { return iso ? iso.slice(0, 10) : 'never'; }
function estTokens(b) { return Math.round(b / 4); }
function pad(s, n) {
    s = String(s);
    return s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length);
}

function report(c) {
    const rows = c.rows.slice().sort((a, b) => {
        const af = a.model + a.typed;
        const bf = b.model + b.typed;
        if (af !== bf) return af - bf;                 // never-fired first: they are the finding
        return b.listingBytes - a.listingBytes;
    });
    const invocable = rows.filter((r) => r.invocable);
    const dead = invocable.filter((r) => r.model + r.typed === 0);
    const deadBytes = dead.reduce((s, r) => s + r.listingBytes, 0);
    const allBytes = rows.reduce((s, r) => s + r.listingBytes, 0);

    console.log('skill census');
    console.log('  population: ' + rows.length + ' skill(s) read from ' + PLUGINS_DIR);
    console.log('              ' + c.transcripts + ' transcript(s) in the last ' + c.days
        + 'd, ' + c.megabytes + ' MB, ' + c.unreadable + ' unreadable');
    // Both channel counts, always, so a blind reader is visible in the header
    // rather than only in a column of zeroes that reads as a corpus finding.
    console.log('              ' + c.totalHits + ' invocation(s) seen: '
        + c.modelHits + ' model-chosen, ' + c.typedHits + ' typed');
    const R = c.render;
    if (R) {
        console.log('              ' + R.listings + ' skill listing(s) read: ' + R.entriesPerListing
            + ' entries each, ' + R.describedPerListing + ' of them WITH a description ('
            + R.describedBytesPerListing + ' bytes)');
    }
    console.log('');
    console.log('  ' + pad('skill', 24) + pad('inv', 5) + pad('model', 7) + pad('typed', 7)
        + pad('last fired', 12) + (R ? pad('shown', 7) : '') + pad('bytes', 7) + '~tok');
    for (const r of rows) {
        console.log('  ' + pad(r.name, 24) + pad(r.invocable ? 'yes' : 'no', 5)
            + pad(String(r.model), 7) + pad(String(r.typed), 7)
            + pad(fmtDate(r.lastFired), 12)
            + (R ? pad(r.slots + '/' + R.listings, 7) : '')
            + pad(String(r.listingBytes), 7)
            + String(estTokens(r.listingBytes)));
    }
    console.log('');
    console.log('  user-invocable: ' + invocable.length + ', of which ' + dead.length
        + ' fired 0 times in ' + c.days + 'd');
    console.log('  listing cost of those ' + dead.length + ': ' + deadBytes + ' bytes, ~'
        + estTokens(deadBytes) + ' tokens ESTIMATED at 4 bytes/token, per session that loads them');
    console.log('  listing cost of the whole corpus: ' + allBytes + ' bytes, ~'
        + estTokens(allBytes) + ' tokens ESTIMATED');

    if (R) {
        // The number above is what the corpus would charge a host that rendered
        // every description. What the dead skills actually charge is their bare
        // names, and the gap between the two decides whether retiring them is a
        // context saving or only a tidiness one.
        const bare = dead.reduce((s, r) => s + ('- ' + r.plugin + ':' + r.name).length, 0);
        const withSlot = dead.filter((r) => r.slots > 0).length;
        console.log('  of those ' + dead.length + ', ' + withSlot
            + ' were ever SHOWN with a description across ' + R.listings + ' listing(s)');
        console.log('  so their real listing cost is their bare names: ' + bare + ' bytes, ~'
            + estTokens(bare) + ' tokens ESTIMATED -- '
            + (bare ? (deadBytes / bare).toFixed(1) : '?') + 'x less than the figure above');
    } else {
        console.log('  (that figure assumes every description is rendered. Run --rendered'
            + ' to find out how many actually are.)');
    }
}

// ------------------------------------------------------------------- selftest

function row3(c, n) { return c.rows.filter((r) => r.name === n)[0]; }

function selftest() {
    let failed = 0;
    let count = 0;
    const ok = (name, cond, extra) => {
        count++;
        console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  <-- ' + extra));
        if (!cond) failed++;
    };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-census-'));
    const pluginsDir = path.join(tmp, 'plugins', 'demo', 'skills');

    const mk = (n, fm) => {
        fs.mkdirSync(path.join(pluginsDir, n), { recursive: true });
        fs.writeFileSync(path.join(pluginsDir, n, 'SKILL.md'), '---\n' + fm + '\n---\n\n# ' + n + '\n', 'utf8');
    };
    mk('firing', 'name: firing\ndescription: A skill that fires.\nwhen_to_use: "when testing"\nuser-invocable: true');
    mk('silent', 'name: silent\ndescription: A skill that never fires.\nwhen_to_use: "never"\nuser-invocable: true');
    mk('ruleish', 'name: ruleish\ndescription: An auto-loaded rule.\nuser-invocable: false');

    // A transcript where a LATER line carries no invocation, so a reader that took
    // the newest timestamp in the file, or the file's mtime, would date the skill
    // to the wrong day. That is the planted positive for the timestamp resolver.
    const t = path.join(tmp, 'a.jsonl');
    fs.writeFileSync(t, [
        '{"timestamp":"2026-09-10T10:00:00.000Z","x":1}',
        '{"timestamp":"2026-09-17T09:00:00.000Z","tool":{"skill":"demo:firing"}}',
        '{"timestamp":"2026-09-18T23:00:00.000Z","note":"later line, no invocation"}',
        '{"timestamp":"2026-09-12T08:00:00.000Z","text":"<command-name>/firing</command-name>"}',
    ].join('\n'), 'utf8');

    const c = census({ days: 3650, dir: tmp, pluginsDir: path.join(tmp, 'plugins'), files: [t] });
    const row = (n) => c.rows.filter((r) => r.name === n)[0];

    ok('planted positive: the firing skill is counted on the model channel',
        row('firing').model === 1, 'got ' + row('firing').model);
    ok('planted positive: the firing skill is counted on the typed channel',
        row('firing').typed === 1, 'got ' + row('firing').typed);
    ok('planted negative: the silent skill stays at zero',
        row('silent').model + row('silent').typed === 0,
        'got ' + (row('silent').model + row('silent').typed));
    ok('last fired is the newest INVOCATION, not the newest line in the file',
        row('firing').lastFired === '2026-09-17T09:00:00.000Z', 'got ' + row('firing').lastFired);
    ok('a never-fired skill has no date at all',
        row('silent').lastFired === null, 'got ' + row('silent').lastFired);
    ok('user-invocable: false is read from frontmatter', row('ruleish').invocable === false);
    ok('user-invocable: true is read from frontmatter', row('firing').invocable === true);
    ok('a quoted description is unquoted before it is measured',
        row('firing').description === 'A skill that fires.',
        'got ' + JSON.stringify(row('firing').description));
    ok('listing bytes count name, description and when_to_use together',
        row('firing').listingBytes > row('firing').descBytes + row('firing').whenBytes,
        'got ' + row('firing').listingBytes);
    ok('a skill with no when_to_use still gets a listing size', row('ruleish').listingBytes > 0);
    ok('the probe reports what it scanned',
        c.transcripts === 1 && c.totalHits === 2,
        'transcripts=' + c.transcripts + ' hits=' + c.totalHits);

    // The control that the census can go BLIND: change the field name and the
    // counts must collapse to zero rather than silently keeping the old answer.
    const blind = path.join(tmp, 'b.jsonl');
    fs.writeFileSync(blind, '{"timestamp":"2026-09-17T09:00:00.000Z","tool":{"skiII":"demo:firing"}}\n', 'utf8');
    const c2 = census({ days: 3650, dir: tmp, pluginsDir: path.join(tmp, 'plugins'), files: [blind] });
    ok('a transcript with no recognisable field yields zero hits, not a stale count',
        c2.totalHits === 0, 'got ' + c2.totalHits);

    // ---- the listing reader, and the escape that defeated its first version.
    // The separator here is a real backslash and a real `n`, written as they
    // appear in a transcript's raw bytes. A reader that splits on a newline
    // finds one line, matches nothing, and reports every skill as undescribed.
    const listing = path.join(tmp, 'c.jsonl');
    const L = '\\n';
    fs.writeFileSync(listing, '{"timestamp":"2026-09-17T09:00:00.000Z","content":"'
        + LISTING_HEADER + ':' + L + L
        + '- demo:firing: A skill that fires. - when testing' + L
        + '- demo:silent' + L
        + '- demo:ruleish' + L + L
        + 'trailing prose that is not the listing"}\n', 'utf8');

    const l = listingInText(fs.readFileSync(listing, 'utf8'));
    ok('the listing reader survives JSON-escaped line breaks',
        l !== null && l.described.length + l.bare.length === 3,
        l ? 'described=' + l.described.length + ' bare=' + l.bare.length : 'no listing found');
    ok('a described entry is told apart from a bare one',
        l && l.described.length === 1 && l.described[0].name === 'demo:firing',
        l ? JSON.stringify(l.described) : 'none');
    ok('bare entries are counted, not dropped',
        l && l.bare.length === 2, l ? JSON.stringify(l.bare.map((b) => b.name)) : 'none');
    ok('the listing stops at the blank line, so trailing prose is not read as entries',
        l && !l.bare.concat(l.described).some((e) => /trailing/.test(e.name)));
    ok('a transcript with no listing at all returns null rather than an empty listing',
        listingInText('{"timestamp":"2026-09-17T09:00:00.000Z","content":"no listing here"}') === null);

    const c3 = census({
        days: 3650, dir: tmp, pluginsDir: path.join(tmp, 'plugins'),
        files: [listing], rendered: true, renderLimit: 25,
    });
    ok('--rendered attaches a slot count to the skill that was shown with a description',
        row3(c3, 'firing').slots === 1, 'got ' + row3(c3, 'firing').slots);
    ok('--rendered leaves a bare-listed skill on zero slots',
        row3(c3, 'silent').slots === 0 && row3(c3, 'silent').listedIn === 1,
        'slots=' + row3(c3, 'silent').slots + ' listedIn=' + row3(c3, 'silent').listedIn);
    ok('--rendered reports what it read',
        c3.render.listings === 1 && c3.render.entriesPerListing === 3,
        JSON.stringify(c3.render));

    // A skill listed TWICE in one listing must score one, not two. Without the
    // per-listing dedupe the real table printed a count larger than its own
    // denominator, which is a ratio that cannot be true and was the only tell.
    const dup = path.join(tmp, 'd.jsonl');
    fs.writeFileSync(dup, '{"timestamp":"2026-09-17T09:00:00.000Z","content":"'
        + LISTING_HEADER + ':' + L + L
        + '- demo:firing: A skill that fires. - when testing' + L
        + '- other:firing: The same bare name from another plugin. - also testing' + L + L
        + 'end"}\n', 'utf8');
    const c4 = census({
        days: 3650, dir: tmp, pluginsDir: path.join(tmp, 'plugins'),
        files: [dup], rendered: true, renderLimit: 25,
    });
    ok('a bare name listed twice in ONE listing counts once, not twice',
        row3(c4, 'firing').slots === 1, 'got ' + row3(c4, 'firing').slots);
    ok('no skill can be shown in more listings than were read',
        c4.rows.every((r) => r.slots <= c4.render.listings),
        'max slots=' + Math.max.apply(null, c4.rows.map((r) => r.slots)));

    // ---- the probe guard, including the asymmetric case the sum cannot see.
    ok('a working census is not called broken',
        probeVerdict({ transcripts: 10, totalHits: 40, modelHits: 20, typedHits: 20 }) === null);
    ok('zero invocations anywhere is called broken',
        /PROBE BROKEN/.test(probeVerdict({ transcripts: 500, totalHits: 0, modelHits: 0, typedHits: 0 }) || ''));
    ok('ONE blind reader is called broken, though the total looks healthy',
        /PROBE BROKEN/.test(probeVerdict({ transcripts: 500, totalHits: 99, modelHits: 0, typedHits: 99 }) || ''),
        'a healthy total hid a dead model channel');
    ok('  and the message names which channel to distrust',
        /model channel saw NONE/.test(probeVerdict({ transcripts: 500, totalHits: 99, modelHits: 0, typedHits: 99 }) || ''));
    ok('the mirror case is caught too',
        /typed channel saw NONE/.test(probeVerdict({ transcripts: 500, totalHits: 99, modelHits: 99, typedHits: 0 }) || ''));
    ok('a tiny corpus with one empty channel is NOT called broken',
        probeVerdict({ transcripts: 2, totalHits: 3, modelHits: 3, typedHits: 0 }) === null,
        'a loose threshold is deliberate: a guard that cries wolf gets muted');

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
    console.log('');
    console.log('selftest: ' + count + ' assertion(s), ' + failed + ' failed');
    return failed === 0 ? 0 : 1;
}

// ----------------------------------------------------------------------- main

if (require.main === module) {
    if (has('--selftest')) {
        process.exitCode = selftest();
    } else {
        const c = census({
            days: parseInt(opt('--days', '7'), 10),
            dir: opt('--dir', PROJECTS_DIR),
            pluginsDir: opt('--plugins', PLUGINS_DIR),
            plugin: opt('--plugin', null),
            rendered: has('--rendered'),
            renderLimit: parseInt(opt('--listings', '25'), 10),
        });
        if (has('--json')) console.log(JSON.stringify(c, null, 2));
        else report(c);
        const broken = probeVerdict(c);
        if (broken) {
            console.error(broken);
            process.exitCode = 2;
        }
    }
}

module.exports = {
    hitsInText: hitsInText,
    timestampBefore: timestampBefore,
    timestampIndex: timestampIndex,
    fmValue: fmValue,
    readCorpus: readCorpus,
    listingInText: listingInText,
    renderAudit: renderAudit,
    census: census,
};
