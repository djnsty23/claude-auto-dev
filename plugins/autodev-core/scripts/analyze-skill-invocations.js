#!/usr/bin/env node
/**
 * Which skills actually fire, and which are unreachable in practice?
 *
 * `[measured 2026-08-25]` Across 558 transcripts in seven days, 4 of this
 * plugin's 45 user-invocable skills fired at all. A skill nobody invokes is
 * indistinguishable from a skill that does not exist, so that number is the
 * single most useful thing to know about a skill library, and nothing was
 * measuring it.
 *
 * THE SPLIT IS THE FINDING, not the total. Of those four, exactly ONE was
 * reached by the model choosing it, and three were reached only because a person
 * typed a slash command. So the two channels are in completely different health:
 * a handful of skills are reachable by hand, and the model-initiated channel is
 * effectively dead. Those need different fixes, and a merged count hides which
 * one you have.
 *
 * THREE DISTINCTIONS THAT DECIDE WHETHER THE NUMBER MEANS ANYTHING:
 *
 * 1. TWO CHANNELS, counted separately. See commandsInText below for the control
 *    that caught a first version reading only one of them and reporting a
 *    tenfold-too-low answer with total confidence.
 *
 * 2. The `skill` field records auto-loaded `rule-*` skills alongside real
 *    invocations. A `rule-*` hit is a paths glob firing, not a person or a model
 *    choosing, so counting them together inflates the figure with exactly the
 *    skills that need no reaching for. They are reported separately.
 *
 * 3. A total of zero is a claim about this probe, not about the world. If either
 *    field name ever changes, every count silently becomes zero and the report
 *    reads as a catastrophic finding rather than a broken reader. So a zero
 *    TOTAL is treated as PROBE BROKEN and exits 2, distinct from the exit 1
 *    that means "the probe works and your skills are unreachable".
 *
 * The zero list is the output that matters. A ranked table of what did fire is
 * mildly interesting; the list of what never fired is the finding.
 *
 * Exit codes: 0 nothing alarming, 1 skills exist that never fire, 2 the probe
 * itself could not see anything and its numbers must not be believed.
 *
 * Usage:
 *   node analyze-skill-invocations.js
 *   node analyze-skill-invocations.js --days 30
 *   node analyze-skill-invocations.js --dir /path/to/projects --plugins /path/to/plugins
 *   node analyze-skill-invocations.js --json
 *   node analyze-skill-invocations.js --selftest
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => args.indexOf(name) >= 0;
const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const HOME = process.env.USERPROFILE || process.env.HOME || '';

/**
 * Pull skill invocations out of one transcript's raw text.
 *
 * Deliberately a regex over the raw bytes rather than a JSON parse per line. A
 * transcript is large, frequently truncated mid-write while a session is live,
 * and a parse failure on one line would drop the whole file. A regex over raw
 * text degrades to missing a line rather than missing a session.
 */
function skillsInText(text) {
    const out = [];
    const re = /"skill"\s*:\s*"([a-zA-Z0-9:_-]+)"/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
}

/**
 * Pull USER-TYPED slash commands out of one transcript's raw text.
 *
 * THIS IS THE HALF THAT WAS MISSED, and missing it inverted the answer.
 * `[measured 2026-08-25]` A first version of this script counted only the
 * `"skill"` field and reported that exactly ONE of this plugin's skills had ever
 * been invoked. The control that caught it: `autodev-core:brain` appears 2,138
 * times in the raw transcripts and ZERO times in that field, because a person
 * typing `/autodev-core:brain` is recorded as a command block, not as a Skill
 * tool call.
 *
 * So there are two independent channels and they mean different things. The
 * `skill` field is the MODEL choosing to load something. The command block is a
 * PERSON typing it. A skill reachable by one and not the other is a different
 * problem from a skill reachable by neither, and a count that merges them
 * silently cannot tell you which you have.
 */
function commandsInText(text) {
    const out = [];
    const re = /<command-name>\s*\/?([A-Za-z0-9:_-]{1,60})\s*<\/command-name>/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
}

/** `autodev-core:rule-diagnosis` -> `rule-diagnosis`; `lessons` -> `lessons`. */
function bareName(skill) {
    const s = String(skill || '');
    const i = s.lastIndexOf(':');
    return i >= 0 ? s.slice(i + 1) : s;
}

function walkJsonl(dir, sinceMs, budget) {
    const found = [];
    const stack = [dir];
    while (stack.length) {
        if (found.length >= budget) break;
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
            found.push({ path: p, size: st.size });
        }
    }
    return found;
}

/** Read every SKILL.md under plugins/, split by whether a user can type it. */
function readSkillInventory(pluginsDir) {
    const invocable = [];
    const autoOnly = [];
    let plugins = [];
    try { plugins = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory()); }
    catch (e) { return { invocable: invocable, autoOnly: autoOnly, error: e.message }; }

    for (const p of plugins) {
        const skillsDir = path.join(pluginsDir, p.name, 'skills');
        let names = [];
        try { names = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
        catch (e) { continue; }
        for (const n of names) {
            const f = path.join(skillsDir, n, 'SKILL.md');
            let body = '';
            try { body = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
            // Frontmatter only. `user-invocable` appearing in prose lower down is
            // discussion of the field, not a declaration of it.
            const fmEnd = body.indexOf('\n---', 4);
            const fm = fmEnd > 0 ? body.slice(0, fmEnd) : body.slice(0, 800);
            (/^user-invocable:\s*false/m.test(fm) ? autoOnly : invocable).push(n);
        }
    }
    return { invocable: invocable, autoOnly: autoOnly };
}

function analyse(o) {
    const sinceMs = Date.now() - o.days * 86400000;
    const files = walkJsonl(o.dir, sinceMs, o.budget);

    const counts = new Map();     // Skill-tool calls: the MODEL chose
    const cmdCounts = new Map();  // slash commands: a PERSON typed
    let bytes = 0, unreadable = 0;
    for (const f of files) {
        let text = '';
        try { text = fs.readFileSync(f.path, 'utf8'); } catch (e) { unreadable++; continue; }
        bytes += f.size;
        for (const s of skillsInText(text)) counts.set(s, (counts.get(s) || 0) + 1);
        for (const c of commandsInText(text)) cmdCounts.set(c, (cmdCounts.get(c) || 0) + 1);
    }

    const inv = readSkillInventory(o.pluginsDir);
    const invSet = new Set(inv.invocable);
    const autoSet = new Set(inv.autoOnly);

    let mine = 0, auto = 0, foreign = 0;
    let typedMine = 0, typedForeign = 0;
    const firedInvocable = new Set();   // fired by EITHER channel
    const firedByModel = new Set();
    const firedByUser = new Set();
    const firedAuto = new Set();

    for (const [name, n] of counts) {
        const bare = bareName(name);
        if (invSet.has(bare)) { mine += n; firedInvocable.add(bare); firedByModel.add(bare); }
        else if (autoSet.has(bare)) { auto += n; firedAuto.add(bare); }
        else foreign += n;
    }
    for (const [name, n] of cmdCounts) {
        const bare = bareName(name);
        if (invSet.has(bare)) { typedMine += n; firedInvocable.add(bare); firedByUser.add(bare); }
        else if (autoSet.has(bare)) { firedAuto.add(bare); }
        else typedForeign += n;
    }

    const never = inv.invocable.filter((n) => !firedInvocable.has(n)).sort();
    const total = mine + auto + foreign + typedMine + typedForeign;

    return {
        days: o.days,
        transcripts: files.length,
        unreadable: unreadable,
        megabytes: +(bytes / 1048576).toFixed(1),
        total: total,
        mine: mine, auto: auto, foreign: foreign,
        typedMine: typedMine, typedForeign: typedForeign,
        distinct: counts.size, distinctTyped: cmdCounts.size,
        invocable: inv.invocable.length,
        autoOnly: inv.autoOnly.length,
        firedInvocable: [...firedInvocable].sort(),
        firedByModel: [...firedByModel].sort(),
        firedByUser: [...firedByUser].sort(),
        firedAuto: [...firedAuto].sort(),
        never: never,
        top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
        topTyped: [...cmdCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
        inventoryError: inv.error || null,
    };
}

function report(r) {
    if (r.inventoryError) {
        console.log('COULD NOT CHECK - the skill inventory could not be read: ' + r.inventoryError);
        console.log('That is not a pass. Nothing was compared.');
        return 2;
    }

    console.log('population: ' + r.transcripts + ' transcript(s) in the last ' + r.days +
        'd, ' + r.megabytes + ' MB read, ' + r.unreadable + ' unreadable');
    console.log('inventory:  ' + r.invocable + ' user-invocable skill(s), ' + r.autoOnly +
        ' auto-loaded rule-* skill(s)');
    console.log('');

    // A zero TOTAL is a claim about the reader, not about the world.
    if (r.total === 0) {
        console.log('PROBE BROKEN - zero skill invocations of ANY kind were found.');
        console.log('That is not a finding about your skills. A transcript that records no');
        console.log('skill at all almost certainly means the field name changed, so every');
        console.log('count below would be a false zero. Fix the reader before believing it.');
        return 2;
    }

    console.log('invocations: ' + r.total + ' across TWO channels, which mean different things');
    console.log('');
    console.log('  MODEL chose (Skill tool), ' + r.distinct + ' distinct:');
    console.log('    ' + String(r.mine).padStart(5) + '  this plugin, user-invocable');
    console.log('    ' + String(r.auto).padStart(5) + '  this plugin, auto-loaded rule-* (a glob fired, nobody chose)');
    console.log('    ' + String(r.foreign).padStart(5) + '  outside this plugin (built-ins, knowledge bases)');
    for (const [name, n] of r.top) console.log('      ' + String(n).padStart(4) + '  ' + name);
    console.log('');
    console.log('  PERSON typed (slash command), ' + r.distinctTyped + ' distinct:');
    console.log('    ' + String(r.typedMine).padStart(5) + '  this plugin');
    console.log('    ' + String(r.typedForeign).padStart(5) + '  built-in or unknown');
    for (const [name, n] of r.topTyped) console.log('      ' + String(n).padStart(4) + '  /' + name);
    console.log('');

    console.log('FIRED by EITHER channel, of this plugin\'s ' + r.invocable +
        ' user-invocable skills: ' + r.firedInvocable.length);
    if (r.firedInvocable.length) console.log('  ' + r.firedInvocable.join(', '));
    console.log('    by model: ' + (r.firedByModel.join(', ') || 'none') +
        '  |  by person: ' + (r.firedByUser.join(', ') || 'none'));
    console.log('');
    console.log('NEVER FIRED in ' + r.days + 'd: ' + r.never.length + ' of ' + r.invocable);
    if (r.never.length) {
        const lines = [];
        for (let i = 0; i < r.never.length; i += 6) lines.push('  ' + r.never.slice(i, i + 6).join(', '));
        for (const l of lines) console.log(l);
    }
    console.log('');
    console.log('A skill nobody invokes is indistinguishable from one that does not exist.');
    console.log('This is a REACHABILITY number, not a quality one: the list above says');
    console.log('nothing about whether those skills are good, only that nothing reached them.');

    return r.never.length ? 1 : 0;
}

function selftest() {
    let fail = 0;
    // `ran` exists so the count below is DERIVED. It read a literal `15` until
    // 2026-09-02, which is a population that cannot move when the population
    // does — the same defect found in test-brain-panels.js, where a hardcoded
    // "22 scenarios" described a file carrying 24.
    let ran = 0;
    const t = (label, cond, detail) => {
        ran++;
        if (cond) console.log('ok   ' + label);
        else { fail++; console.log('FAIL ' + label + (detail ? ' - ' + detail : '')); }
    };

    const sample = '{"type":"x","skill":"artifact-design"}\n{"skill":"autodev-core:rule-diagnosis"}\n' +
        '{"skill" : "gtm-kb"}\nnot json at all "skill":"phase"\n';
    const got = skillsInText(sample);
    t('extracts every skill occurrence', JSON.stringify(got) ===
        JSON.stringify(['artifact-design', 'autodev-core:rule-diagnosis', 'gtm-kb', 'phase']),
        JSON.stringify(got));
    t('reads a plugin-prefixed name', got.indexOf('autodev-core:rule-diagnosis') >= 0);
    t('survives a line that is not valid JSON', got.indexOf('phase') >= 0);
    t('finds nothing in text with no skill field', skillsInText('{"a":1}').length === 0);

    t('bareName strips a plugin prefix', bareName('autodev-core:rule-diagnosis') === 'rule-diagnosis');
    t('bareName leaves an unprefixed name alone', bareName('lessons') === 'lessons');
    t('bareName tolerates empty input', bareName('') === '');

    // The command channel is the half a first version missed entirely, so it
    // gets a known-positive of its own rather than being assumed to work.
    // Joined rather than escaped. A literal newline escape through a shell
    // heredoc collapses into a real line break and breaks the file, which is how
    // this block was written wrong the first time.
    const cmdSample = [
        '<command-name>/autodev-core:brain</command-name>',
        '<command-name>/audit</command-name>',
        '<command-name>compact</command-name>',
        '<command-name>/?([\\w:.-]{1,40})</command-name>',
    ].join(String.fromCharCode(10));
    const cmds = commandsInText(cmdSample);
    t('extracts a plugin-qualified slash command', cmds.indexOf('autodev-core:brain') >= 0,
        JSON.stringify(cmds));
    t('extracts a bare slash command', cmds.indexOf('audit') >= 0);
    t('tolerates a command written without its slash', cmds.indexOf('compact') >= 0);
    t('refuses a regex literal masquerading as a command', cmds.length === 3, JSON.stringify(cmds));

    // The zero-total guard is the whole reason this can be trusted, so pin it.
    const broken = report({
        inventoryError: null, transcripts: 10, days: 7, megabytes: 1, unreadable: 0,
        total: 0, mine: 0, auto: 0, foreign: 0, typedMine: 0, typedForeign: 0,
        distinct: 0, distinctTyped: 0, invocable: 5, autoOnly: 2,
        firedInvocable: [], firedByModel: [], firedByUser: [], firedAuto: [],
        never: ['a', 'b'], top: [], topTyped: [],
    });
    t('a zero total exits 2 (probe broken), never 1 (finding)', broken === 2, 'got ' + broken);

    const finding = report({
        inventoryError: null, transcripts: 10, days: 7, megabytes: 1, unreadable: 0,
        total: 9, mine: 1, auto: 2, foreign: 6, typedMine: 0, typedForeign: 0,
        distinct: 3, distinctTyped: 0, invocable: 5, autoOnly: 2,
        firedInvocable: ['x'], firedByModel: ['x'], firedByUser: [], firedAuto: [],
        never: ['a', 'b'], top: [['x', 1]], topTyped: [],
    });
    t('skills that never fire exit 1', finding === 1, 'got ' + finding);

    const clean = report({
        inventoryError: null, transcripts: 10, days: 7, megabytes: 1, unreadable: 0,
        total: 9, mine: 0, auto: 0, foreign: 0, typedMine: 9, typedForeign: 0,
        distinct: 0, distinctTyped: 1, invocable: 1, autoOnly: 0,
        firedInvocable: ['x'], firedByModel: [], firedByUser: ['x'], firedAuto: [],
        never: [], top: [], topTyped: [['x', 9]],
    });
    t('everything firing exits 0', clean === 0, 'got ' + clean);

    const err = report({ inventoryError: 'boom' });
    t('an unreadable inventory exits 2, not 0', err === 2, 'got ' + err);

    console.log('');
    console.log(ran + ' cases, ' + fail + ' failed');
    return fail ? 1 : 0;
}

if (flag('--selftest')) process.exit(selftest());

const result = analyse({
    days: Number(opt('--days', '7')) || 7,
    dir: opt('--dir', path.join(HOME, '.claude', 'projects')),
    pluginsDir: opt('--plugins', path.join(__dirname, '..', '..')),
    budget: Number(opt('--max-files', '4000')) || 4000,
});

if (flag('--json')) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.total === 0 ? 2 : (result.never.length ? 1 : 0));
}
process.exit(report(result));
