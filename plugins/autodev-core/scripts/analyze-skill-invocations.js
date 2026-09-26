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
 * 1. SEPARATE CHANNELS, counted separately. See skillEvents below for the
 *    control that caught a first version reading only one of them and
 *    reporting a tenfold-too-low answer with total confidence.
 *
 * 2. `rule-*` skills (`user-invocable: false`) are reported separately from the
 *    ones a person can type. This used to say a `rule-*` hit was a paths glob
 *    firing. `[measured 2026-09-23]` it is not: every one of 29 in 30 days was
 *    a Skill tool call the model chose, and a `paths:` glob loads nothing. The
 *    split stays because the two populations answer different questions.
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
 *   node analyze-skill-invocations.js --help
 */

'use strict';

const fs = require('fs');
const path = require('path');
const claudePaths = require('./claude-paths.js');

const args = process.argv.slice(2);
const flag = (name) => args.indexOf(name) >= 0;
const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};


/**
 * Claude Code's own slash commands. A bare `/status` is the built-in, not this
 * plugin's `status` skill. `[measured 2026-09-26]` six built-in `/status` runs
 * in 30 days were credited to the skill. A plugin-qualified name
 * (`/autodev-core:status`) is never in this set, so it still counts.
 */
const BUILTIN_COMMANDS = new Set([
    'add-dir', 'agents', 'artifacts', 'bug', 'clear', 'compact', 'config', 'context',
    'cost', 'doctor', 'effort', 'exit', 'export', 'fast', 'feedback', 'help', 'hooks',
    'ide', 'init', 'install-github-app', 'login', 'logout', 'mcp', 'memory', 'model',
    'output-style', 'permissions', 'plugin', 'pr-comments', 'privacy-settings',
    'release-notes', 'reload-plugins', 'reload-skills', 'rename', 'resume', 'rewind',
    'sandbox', 'security-review', 'skills', 'status', 'statusline', 'tasks',
    'terminal-setup', 'theme', 'todos', 'upgrade', 'usage', 'vim', 'workflows',
]);

/** The text of a message's content, whether it is a string or an array of blocks. */
function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text).join('\n');
}

/**
 * Every skill load in one transcript's text, each with its own timestamp.
 *
 * THREE CHANNELS, and they mean different things:
 *
 *   model    a `Skill` tool_use block in an assistant record: the MODEL chose it.
 *   typed    a user record that BEGINS with the command block: a PERSON typed it.
 *            `builtin` is the same shape for one of Claude Code's own commands.
 *   preload  an isMeta user record carrying `<skill-format>`: the HARNESS loaded
 *            it, which is an agent's `skills:` frontmatter. Nobody chose it.
 *
 * `[measured 2026-08-25]` a first version read only the `"skill"` field and
 * reported ONE of this plugin's skills as ever invoked. `autodev-core:brain`
 * appeared 2,138 times in the raw transcripts and zero times in that field,
 * because a person typing it is recorded as a command block. So the typed
 * channel is not optional.
 *
 * PARSED PER LINE, NOT MATCHED OVER RAW BYTES. `[measured 2026-09-26]` a regex
 * over the whole file made four errors at once. It dated nothing, so a resumed
 * transcript carried July events into a 30-day window (F1). It matched a
 * `<command-name>` quoted inside a tool_result or an assistant's prose: 29
 * `audit` fires reported, 0 real (F2). It credited the built-in `/status` to the
 * `status` skill (F3). It read the `wireToolInputs` echo of each call as a
 * second call, about 2x (F4). A bad line now costs that line, not the file.
 *
 * `o.sinceMs` drops every event older than it, and every event with no
 * timestamp, because an undated event cannot be shown to be inside the window.
 * `o.seen` is shared across files: a forked or resumed session copies earlier
 * records into a new transcript under the same tool_use id and record uuid.
 */
function skillEvents(text, o) {
    const opts = o || {};
    const seen = opts.seen || new Set();
    const hasWindow = typeof opts.sinceMs === 'number';
    const out = [];
    for (const line of String(text).split('\n')) {
        const maybeModel = line.indexOf('"name":"Skill"') >= 0;
        const maybeCommand = line.indexOf('<command-') >= 0;
        if (!maybeModel && !maybeCommand) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (e) { continue; }
        if (!rec || typeof rec !== 'object') continue;
        const at = typeof rec.timestamp === 'string' ? rec.timestamp : null;
        if (hasWindow) {
            const ms = at ? Date.parse(at) : NaN;
            if (!(ms >= opts.sinceMs)) continue;
        }
        const msg = rec.message || {};
        if (rec.type === 'assistant' && Array.isArray(msg.content)) {
            msg.content.forEach((b, i) => {
                if (!b || b.type !== 'tool_use' || b.name !== 'Skill') return;
                if (!b.input || typeof b.input.skill !== 'string') return;
                const key = 'model ' + (b.id || (msg.id || rec.uuid || at) + '#' + i);
                if (seen.has(key)) return;
                seen.add(key);
                out.push({ name: b.input.skill, channel: 'model', at: at });
            });
            continue;
        }
        if (rec.type !== 'user') continue;
        const t = contentText(msg.content);
        if (!/^\s*<command-(?:name|message)>/.test(t)) continue;
        const m = /<command-name>\s*\/?([A-Za-z0-9:_-]{1,60})\s*<\/command-name>/.exec(t);
        if (!m) continue;
        let channel;
        if (rec.isMeta) {
            if (!/<skill-format>/.test(t)) continue;
            channel = 'preload';
        } else {
            channel = BUILTIN_COMMANDS.has(m[1]) ? 'builtin' : 'typed';
        }
        const key = channel + ' ' + (rec.uuid || at + ' ' + m[1]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name: m[1], channel: channel, at: at });
    }
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

/**
 * The plugin roots to inventory. `--plugins <dir>` means every child of <dir>
 * is a plugin. So does the default in the repo, where this script sits in
 * plugins/<p>/scripts/ and ../.. is plugins/. INSTALLED it sits in
 * cache/<marketplace>/<p>/<version>/scripts/, where ../.. is <p>/ and its
 * children are every cached VERSION of one plugin. `[measured 2026-09-24]` on
 * 8.173.0 with 24 cached versions that listed 184 never-fired skills, 159 of
 * them repeats, and kept retired skills in the inventory.
 *
 * The installed layout is told apart by its plugin directory carrying the
 * manifest's name, which plugins/ never does. Its roots are each plugin in
 * the marketplace at the version directory this script runs from: bump.js
 * writes one version into every plugin, so the siblings share it.
 */
function pluginRoots(explicitDir, scriptsDir) {
    const children = (d) => fs.readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => path.join(d, e.name));
    if (explicitDir) return { layout: 'given', roots: children(explicitDir) };
    const own = path.join(scriptsDir, '..');
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(own, '.claude-plugin', 'plugin.json'), 'utf8')); }
    catch (e) { manifest = null; }
    const installed = !!manifest && !!manifest.name && path.basename(path.dirname(own)) === manifest.name;
    if (!installed) return { layout: 'repo', roots: children(path.join(own, '..')) };
    const version = path.basename(own);
    return {
        layout: 'installed',
        roots: children(path.dirname(path.dirname(own))).map((p) => path.join(p, version)).filter((p) => fs.existsSync(p)),
    };
}

/** Read every SKILL.md under each plugin root, split by whether a user can type it. */
function readSkillInventory(explicitDir, scriptsDir) {
    const invocable = [];
    const autoOnly = [];
    let found;
    try { found = pluginRoots(explicitDir, scriptsDir); }
    catch (e) { return { invocable: invocable, autoOnly: autoOnly, error: e.message }; }
    if (!found.roots.length) {
        return { invocable: invocable, autoOnly: autoOnly, error: 'no plugin roots found in the ' + found.layout + ' layout' };
    }

    for (const root of found.roots) {
        const skillsDir = path.join(root, 'skills');
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
    return { invocable: invocable, autoOnly: autoOnly, layout: found.layout, roots: found.roots.length };
}

function analyse(o) {
    const sinceMs = Date.now() - o.days * 86400000;
    const files = walkJsonl(o.dir, sinceMs, o.budget);

    const counts = new Map();     // Skill-tool calls: the MODEL chose
    const cmdCounts = new Map();  // slash commands: a PERSON typed
    const preCounts = new Map();  // agent `skills:` preloads: the HARNESS loaded
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    // The file's mtime only prefilters: a file last written before the window
    // holds no event inside it. Each event is then windowed by its own
    // timestamp, because a file written today can hold events from July.
    const seen = new Set();
    const builtins = new Set();   // names the reader classed as Claude Code's own
    let bytes = 0, unreadable = 0;
    for (const f of files) {
        let text = '';
        try { text = fs.readFileSync(f.path, 'utf8'); } catch (e) { unreadable++; continue; }
        bytes += f.size;
        for (const e of skillEvents(text, { sinceMs: sinceMs, seen: seen })) {
            bump(e.channel === 'model' ? counts : e.channel === 'preload' ? preCounts : cmdCounts, e.name);
            if (e.channel === 'builtin') builtins.add(e.name);
        }
    }

    const inv = readSkillInventory(o.pluginsDir, o.scriptsDir || __dirname);
    const invSet = new Set(inv.invocable);
    const autoSet = new Set(inv.autoOnly);

    let mine = 0, auto = 0, foreign = 0;
    let typedMine = 0, typedForeign = 0;
    let preloaded = 0;
    const firedInvocable = new Set();   // fired by ANY channel
    const firedByModel = new Set();
    const firedByUser = new Set();
    const firedByPreload = new Set();
    const firedAuto = new Set();
    const bySkill = {};                 // this plugin's skills only, per channel
    const tally = (bare, channel, n) => {
        const row = bySkill[bare] || (bySkill[bare] = { model: 0, typed: 0, preload: 0 });
        row[channel] += n;
    };

    for (const [name, n] of counts) {
        const bare = bareName(name);
        if (invSet.has(bare)) { mine += n; firedInvocable.add(bare); firedByModel.add(bare); tally(bare, 'model', n); }
        else if (autoSet.has(bare)) { auto += n; firedAuto.add(bare); tally(bare, 'model', n); }
        else foreign += n;
    }
    for (const [name, n] of cmdCounts) {
        const bare = bareName(name);
        // The reader decides what is built-in, so `status` here is Claude
        // Code's /status and never this plugin's skill of the same name.
        const builtin = builtins.has(name);
        if (!builtin && invSet.has(bare)) { typedMine += n; firedInvocable.add(bare); firedByUser.add(bare); tally(bare, 'typed', n); }
        else if (!builtin && autoSet.has(bare)) { firedAuto.add(bare); tally(bare, 'typed', n); }
        else typedForeign += n;
    }
    for (const [name, n] of preCounts) {
        const bare = bareName(name);
        preloaded += n;
        if (invSet.has(bare)) { firedInvocable.add(bare); firedByPreload.add(bare); tally(bare, 'preload', n); }
        else if (autoSet.has(bare)) { firedAuto.add(bare); tally(bare, 'preload', n); }
    }

    const never = inv.invocable.filter((n) => !firedInvocable.has(n)).sort();
    const total = mine + auto + foreign + typedMine + typedForeign + preloaded;

    return {
        days: o.days,
        transcripts: files.length,
        unreadable: unreadable,
        megabytes: +(bytes / 1048576).toFixed(1),
        total: total,
        mine: mine, auto: auto, foreign: foreign,
        typedMine: typedMine, typedForeign: typedForeign, preloaded: preloaded,
        distinct: counts.size, distinctTyped: cmdCounts.size,
        invocable: inv.invocable.length,
        autoOnly: inv.autoOnly.length,
        firedInvocable: [...firedInvocable].sort(),
        firedByModel: [...firedByModel].sort(),
        firedByUser: [...firedByUser].sort(),
        firedByPreload: [...firedByPreload].sort(),
        firedAuto: [...firedAuto].sort(),
        bySkill: bySkill,
        never: never,
        top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
        topTyped: [...cmdCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
        inventoryError: inv.error || null,
        inventoryLayout: inv.layout || null,
        pluginRoots: inv.roots || 0,
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
        ' rule-* skill(s) that are not user-invocable' +
        (r.inventoryLayout ? ', from ' + r.pluginRoots + ' plugin root(s) in the ' + r.inventoryLayout + ' layout' : ''));
    console.log('');

    // A zero TOTAL is a claim about the reader, not about the world.
    if (r.total === 0) {
        console.log('PROBE BROKEN - zero skill invocations of ANY kind were found.');
        console.log('That is not a finding about your skills. A transcript that records no');
        console.log('skill at all almost certainly means the field name changed, so every');
        console.log('count below would be a false zero. Fix the reader before believing it.');
        return 2;
    }

    console.log('invocations: ' + r.total + ' across THREE channels, which mean different things');
    console.log('');
    console.log('  MODEL chose (Skill tool), ' + r.distinct + ' distinct:');
    console.log('    ' + String(r.mine).padStart(5) + '  this plugin, user-invocable');
    console.log('    ' + String(r.auto).padStart(5) + '  this plugin, rule-* (not user-invocable, the model chose it)');
    console.log('    ' + String(r.foreign).padStart(5) + '  outside this plugin (built-ins, knowledge bases)');
    for (const [name, n] of r.top) console.log('      ' + String(n).padStart(4) + '  ' + name);
    console.log('');
    console.log('  PERSON typed (slash command), ' + r.distinctTyped + ' distinct:');
    console.log('    ' + String(r.typedMine).padStart(5) + '  this plugin');
    console.log('    ' + String(r.typedForeign).padStart(5) + '  built-in or unknown');
    for (const [name, n] of r.topTyped) console.log('      ' + String(n).padStart(4) + '  /' + name);
    console.log('');
    console.log('  HARNESS preloaded (agent skills: frontmatter): ' + (r.preloaded || 0));
    console.log('');

    console.log('FIRED by ANY channel, of this plugin\'s ' + r.invocable +
        ' user-invocable skills: ' + r.firedInvocable.length);
    if (r.firedInvocable.length) console.log('  ' + r.firedInvocable.join(', '));
    console.log('    by model: ' + (r.firedByModel.join(', ') || 'none') +
        '  |  by person: ' + (r.firedByUser.join(', ') || 'none') +
        '  |  by preload: ' + ((r.firedByPreload || []).join(', ') || 'none'));
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

    // Records in the shapes a real transcript carries. Built with
    // JSON.stringify, one record per line, joined rather than escaped.
    const NL = String.fromCharCode(10);
    const skillCall = (skill, id, at) => JSON.stringify({
        type: 'assistant', timestamp: at || '2026-09-20T10:00:00.000Z', uuid: 'a-' + id,
        message: { id: 'msg_' + id, content: [{ type: 'tool_use', id: id, name: 'Skill', input: { skill: skill } }] },
        wireToolInputs: { [id]: { skill: skill } },
    });
    const typed = (name, uuid, at) => JSON.stringify({
        type: 'user', timestamp: at || '2026-09-20T10:00:00.000Z', uuid: uuid,
        message: { role: 'user', content: '<command-message>' + name + '</command-message>' + NL +
            '<command-name>/' + name + '</command-name>' },
    });
    const preload = (name, uuid) => JSON.stringify({
        type: 'user', isMeta: true, timestamp: '2026-09-20T10:00:00.000Z', uuid: uuid,
        message: { role: 'user', content: [{ type: 'text', text: '<command-message>' + name +
            '</command-message>' + NL + '<command-name>' + name + '</command-name>' + NL + '<skill-format>true</skill-format>' }] },
    });
    const names = (evs, ch) => evs.filter((e) => !ch || e.channel === ch).map((e) => e.name);

    const got = skillEvents([
        skillCall('artifact-design', 'toolu_01'),
        skillCall('autodev-core:rule-diagnosis', 'toolu_02'),
        'not json at all "name":"Skill" "skill":"phase"',
        skillCall('gtm-kb', 'toolu_03'),
    ].join(NL));
    t('extracts every Skill tool_use', JSON.stringify(names(got, 'model')) ===
        JSON.stringify(['artifact-design', 'autodev-core:rule-diagnosis', 'gtm-kb']), JSON.stringify(got));
    t('a line that is not valid JSON costs that line, not the file', got.length === 3);
    t('finds nothing in text with no skill record', skillEvents('{"a":1}').length === 0);

    // F4. The echo that doubled every count: one call in the tool_use block
    // and again in wireToolInputs. Two DIFFERENT ids must both count, or a
    // dedupe keyed too loosely would pass by dropping all.
    const dedup = skillEvents([skillCall('brain', 'toolu_A'), skillCall('brain', 'toolu_B')].join(NL));
    t('F4: a call echoed in wireToolInputs counts once', dedup.length === 2, JSON.stringify(dedup));
    const shared = new Set();
    const copied = skillEvents(skillCall('brain', 'toolu_A'), { seen: shared })
        .concat(skillEvents(skillCall('brain', 'toolu_A'), { seen: shared }));
    t('F4: a call copied into a resumed transcript counts once across files', copied.length === 1,
        JSON.stringify(copied));

    // F1. The window is the event's own timestamp, never the file's mtime.
    const since = Date.parse('2026-09-01T00:00:00.000Z');
    const windowed = skillEvents([
        skillCall('old-one', 'toolu_old', '2026-07-19T10:00:00.000Z'),
        skillCall('new-one', 'toolu_new', '2026-09-20T10:00:00.000Z'),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_nd', name: 'Skill', input: { skill: 'undated' } }] } }),
    ].join(NL), { sinceMs: since });
    t('F1: an event older than the window is dropped though its file is fresh',
        JSON.stringify(names(windowed)) === JSON.stringify(['new-one']), JSON.stringify(windowed));

    t('bareName strips a plugin prefix', bareName('autodev-core:rule-diagnosis') === 'rule-diagnosis');
    t('bareName leaves an unprefixed name alone', bareName('lessons') === 'lessons');
    t('bareName tolerates empty input', bareName('') === '');

    // The command channel is the half a first version missed entirely, so it
    // gets a known-positive of its own rather than being assumed to work.
    const cmds = skillEvents([
        typed('autodev-core:brain', 'u1'),
        typed('audit', 'u2'),
        typed('status', 'u3'),
        preload('security', 'u4'),
    ].join(NL));
    t('extracts a plugin-qualified slash command', names(cmds, 'typed').indexOf('autodev-core:brain') >= 0,
        JSON.stringify(cmds));
    t('extracts a bare slash command', names(cmds, 'typed').indexOf('audit') >= 0);
    t('F3: a bare built-in command is builtin, never typed',
        JSON.stringify(names(cmds, 'builtin')) === JSON.stringify(['status']), JSON.stringify(cmds));
    t('an agent preload is its own channel, not a person typing',
        JSON.stringify(names(cmds, 'preload')) === JSON.stringify(['security']), JSON.stringify(cmds));

    // F2. The tag QUOTED anywhere but at the head of a real user turn.
    const quoted = skillEvents([
        JSON.stringify({ type: 'user', uuid: 'q1', timestamp: '2026-09-20T10:00:00.000Z', message: { content: [
            { type: 'tool_result', content: '<command-name>/audit</command-name>' }] } }),
        JSON.stringify({ type: 'assistant', uuid: 'q2', timestamp: '2026-09-20T10:00:00.000Z', message: { content: [
            { type: 'text', text: '<command-name>/audit</command-name>' }] } }),
        JSON.stringify({ type: 'user', uuid: 'q3', timestamp: '2026-09-20T10:00:00.000Z', message: { content:
            'a prompt that mentions <command-name>/audit</command-name> in passing' } }),
        JSON.stringify({ type: 'system', uuid: 'q4', timestamp: '2026-09-20T10:00:00.000Z',
            content: '<command-name>/status</command-name>' }),
    ].join(NL));
    t('F2: a command tag quoted in a tool_result, prose or a system record is not a load',
        quoted.length === 0, JSON.stringify(quoted));
    const twice = skillEvents([typed('audit', 'same'), typed('audit', 'same')].join(NL));
    t('a typed command recorded twice under one uuid counts once', twice.length === 1, JSON.stringify(twice));

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

const HELP = [
    'analyze-skill-invocations.js: which skills fire, by channel, and which never do.',
    '',
    'Usage: node analyze-skill-invocations.js [--days N] [--dir DIR] [--plugins DIR]',
    '                                         [--max-files N] [--json] [--selftest]',
    '',
    '  --days N         window by each event timestamp, default 7',
    '  --dir DIR        transcript root, default <config dir>/projects',
    '  --plugins DIR    every child of DIR is a plugin root to inventory',
    '  --max-files N    stop after N transcript files, default 4000',
    '  --json           machine-readable, with per-skill counts in bySkill',
    '  --selftest       planted cases for the reader, then exit',
    '  --help, -h       this text, and nothing is read',
    '',
    'Exits 0 when every skill fired, 1 when some never did, 2 when the probe',
    'saw nothing or could not read the inventory.',
].join('\n');

function main() {
    // Before any work. `[measured 2026-09-26]` --help used to fall through to
    // a 7-day analysis of the real transcripts and print it as the answer.
    if (flag('--help') || flag('-h')) { console.log(HELP); return 0; }
    if (flag('--selftest')) return selftest();

    const result = analyse({
        days: Number(opt('--days', '7')) || 7,
        dir: opt('--dir', path.join(claudePaths.configDir(), 'projects')),
        pluginsDir: opt('--plugins', null),
        budget: Number(opt('--max-files', '4000')) || 4000,
    });

    if (flag('--json')) {
        console.log(JSON.stringify(result, null, 2));
        return result.total === 0 ? 2 : (result.never.length ? 1 : 0);
    }
    return report(result);
}

// process.exit() TRUNCATES output, and only on some platforms.
//
// node's process.stdout is ASYNCHRONOUS when it is a PIPE on POSIX (Linux and
// macOS alike) and synchronous when it is a pipe on win32; it is synchronous
// for a FILE everywhere. process.exit() terminates without draining a
// pending async write, so a run that prints more than the 64KiB OS pipe buffer
// and then exits delivers exactly 65536 bytes — under exit status 0, because
// the write never failed. A silent wrong answer, not a visible failure. The
// three things that hide it: a file redirect is synchronous so the output looks
// whole, the status is 0 so CI stays green (a Linux pipe is asynchronous too,
// so CI is exposed and cannot see it), and nothing compares byte counts.
//
// Setting process.exitCode instead lets the event loop drain the stream and
// exit on its own with the same status. Nothing here holds the loop open.
// See rendered-layout-gate.js for the case that cost this, and CLAUDE.md under
// conventions that have actually cost something.
if (require.main === module) process.exitCode = main();

module.exports = { skillEvents: skillEvents, bareName: bareName, BUILTIN_COMMANDS: BUILTIN_COMMANDS };
