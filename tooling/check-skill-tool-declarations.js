#!/usr/bin/env node
'use strict';

// check-skill-tool-declarations.js
//
// A skill's body must not mandate a tool its frontmatter does not declare.
//
// THE INCIDENT. `auto-brain` step 5 read "`mcp__ccd_session_mgmt__send_message`,
// one per session" while its `allowed-tools` listed neither that nor
// `spawn_task`. A coordinator running it had no way to start a session for a
// repo that had none, so it did four repos of work inline instead, and two
// branch collisions followed. The prose gap and the frontmatter gap were the
// same bug wearing two faces: the procedure was written assuming a capability
// the harness had not been told to grant.
//
// ---------------------------------------------------------------------------
// THE RULE: WHAT COUNTS AS AN INSTRUCTION, AND WHAT IS ONLY A MENTION
// ---------------------------------------------------------------------------
//
// This is the whole design decision, so it is written down rather than left in
// the regexes. Six of the harness tool names -- Read, Write, Edit, Task, Agent,
// Bash -- are ordinary English words, so proximity can never be the signal. Two
// tests must BOTH pass before a line is flagged.
//
// TEST 1 -- IS IT A TOOL REFERENCE AT ALL?
//   Only two forms qualify, because only these two cannot be ordinary prose:
//     * an `mcp__`-prefixed token, which is a tool name by construction; or
//     * a bare name from the hardcoded VOCAB below, written in backticks.
//   `Read` is a tool reference. "read the file" is not, and never will be.
//   The vocabulary is a HARDCODED LITERAL, not derived from the corpus's own
//   allowed-tools lines. Deriving it would mean a tool deleted from every
//   declaration silently leaves the vocabulary too, weakening the check and its
//   own controls in one motion (rule-gate-integrity, section 3).
//
// TEST 2 -- IS THE REFERENCE A MANDATE?
//   POSITIVE-ONLY. A line is flagged only when it carries an explicit mandating
//   construction; nothing is flagged for merely containing a tool name. This
//   direction is deliberate. A quotation, a template, a caveat and a cost
//   comparison all lack a mandating construction, so they fall through without
//   the check having to recognise what they are -- which it would do badly.
//   The bias is toward false negatives, because a detector that cries wolf gets
//   muted and then misses the real thing.
//
//   A mandate is one of:
//     M1 an imperative or prescriptive verb governing the token in the same
//        sentence -- use, call, run, invoke, prefer, spawn, send, dispatch,
//        query, drive, subscribe, reach for, route through;
//     M2 the token standing as the operative content of a procedure step --
//        it opens a numbered step, a bulleted step, or the line directly under
//        a step heading;
//     M3 a call signature -- the token immediately followed by `{` or `(`,
//        which is a form only an actual invocation takes.
//
// FOUR NEGATIVE CLASSES, each of which OVERRIDES a mandate match. These are the
// false positives the crude first scan produced, and each is a real line in
// this corpus:
//
//   N1 NEGATED -- the sentence denies, forbids, or reports unavailability.
//      "do not use WebFetch here", "`TodoWrite` are not available on Opus 4.8",
//      "`brain-panels.js --off` denies `AskUserQuestion`", "use numbered prose
//      instead". Naming a tool in order to rule it out is the opposite of
//      requiring it, and flagging it would push authors toward declaring tools
//      they went out of their way to forbid.
//
//   N2 CONDITIONAL ON AVAILABILITY -- "if Context7 tools are available, prefer
//      them", "if the browser tools are unavailable, `WebFetch` verifies...".
//      The author has written the absent case, so absence cannot strand the
//      procedure. This is exactly what auto-brain did NOT do, which is why the
//      distinction is the load-bearing one and not a convenience: a conditional
//      degrades, a mandate deadlocks.
//
//   N3 PROPERTY CLAIM -- the token is the SUBJECT of a verb describing the
//      tool's own behaviour: "`AskUserQuestion` caps options at 4",
//      "`SendMessage` success is acceptance by the transport", "`SendMessage`
//      takes `notify_when_idle`". Describing a tool is not commanding it.
//
//   N4 QUOTED MATERIAL -- a fenced, blockquoted or indented passage introduced
//      by a quoting cue ("says", "reads", "verbatim", "quoted", "instruction:").
//      A skill reproducing another document's instructions is reporting, not
//      instructing.
//
// A wildcard reference (`mcp__Claude_Browser__*`) is compared at its namespace,
// so declaring the namespace satisfies it and declaring one member does not.
//
// PRECISION, measured on the first corpus run rather than claimed:
// 12 findings, 12 triaged by hand, 12 real. No false positives. That run is
// what earned the wiring; the selftest only proves the check CAN fire.
//
// KNOWN LIMITS, printed beside every result so a clean run is not read as more
// than it is. The third one is MEASURED, not hypothetical:
//   * Scope is one sentence for the mandate and the conditional, one CLAUSE for
//     the negation. A mandate in one sentence and its negation in the next is
//     not connected, in either direction.
//   * Bare names only count in backticks, so a skill instructing a tool in
//     plain prose ("use the Write tool") is not seen. Swept 2026-09-01: zero
//     instances in this corpus, so the limit is currently theoretical.
//   * A short alias is only recognised where the same file also writes the tool
//     out in full at least once. Swept 2026-09-01: THREE REAL DEFECTS SIT IN
//     THIS BLIND SPOT and no version of this check can see them. rule-local-first
//     mandates `preview_start` (line 30) and `resize_window` (line 208);
//     sessions says "call `archive_session` with its `sessionId`" (line 128).
//     None of those three names appears in full anywhere in the corpus, so a
//     per-file alias map cannot resolve them and a corpus-wide one cannot
//     either. Closing this needs a registry of MCP tool short names that this
//     repo does not have; inventing the list would rot silently as tools
//     change, which is worse than a stated gap. The three declarations were
//     added by hand, so the tree is correct while the CHECK still cannot
//     enforce that class. A future skill can reintroduce it unseen.
//   * `allowed-tools` is read as a flat comma list; it does not model the
//     harness's own inheritance or the "All tools except X" agent form.
//
// Usage:
//   node tooling/check-skill-tool-declarations.js            scan, exit 1 on findings
//   node tooling/check-skill-tool-declarations.js --advisory scan, always exit 0
//   node tooling/check-skill-tool-declarations.js --selftest fixtures, both directions
//   node tooling/check-skill-tool-declarations.js --all      also list every reference

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS = path.join(ROOT, 'plugins');

// Hardcoded on purpose -- see TEST 1. These are harness tool names, an external
// contract, not something this repo's own files get to redefine.
const VOCAB = [
    'Agent', 'AskUserQuestion', 'Bash', 'BashOutput', 'Edit', 'ExitPlanMode',
    'Glob', 'Grep', 'KillShell', 'NotebookEdit', 'Read', 'SendMessage', 'Skill',
    'SlashCommand', 'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'Workflow',
    'Write',
];

// Bare and -ing forms only. The third-person plural forms are excluded because
// they double as nouns in exactly this corpus: "Fifty `Bash` calls returning a
// line each are cheap" is a cost comparison, not an instruction to call Bash.
// That case is a real line in `telemetry` and it is why the verb must also
// PRECEDE the token -- see mandateClass.
const MANDATE_VERBS = [
    'use', 'using', 'call', 'calling', 'run', 'running', 'invoke', 'invoking',
    'prefer', 'spawn', 'send', 'sending', 'dispatch', 'query', 'drive',
    'subscribe', 'reach for', 'route through', 'go through',
];

const NEGATORS = [
    'not available', 'unavailable', 'never', 'do not', 'don’t', "don't",
    'denies', 'deny', 'denied', 'blocked', 'blocks', 'instead of', 'rather than',
    'cannot', "can't", 'no longer', 'forbid', 'refuses', 'refuse', 'avoid',
    'instead', 'absent', 'removed', 'without',
];

const CONDITIONALS = [
    'if the', 'if a ', 'if any', 'if it', 'if they', 'if you', 'if present',
    'when available', 'if available', 'are available', 'is available',
    'if unavailable', 'are unavailable', 'is unavailable', 'where available',
    'check if', 'when present', 'optional', 'fall back', 'fallback',
];

const PROPERTY_VERBS = [
    'caps', 'takes', 'returns', 'accepts', 'reports', 'emits', 'costs',
    'succeeds', 'fails', 'exists', 'lists', 'puts', 'governs', 'means',
    'is', 'are', 'was', 'were', 'has', 'have', 'does',
];

const QUOTE_CUES = [
    'says', 'said', 'reads', 'read:', 'verbatim', 'quoted', 'quoting', 'quote',
    'instruction:', 'instructions:', 'wording', 'in as many words', 'template',
    'reproduced', 'unedited',
];

function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name === 'SKILL.md') out.push(p);
    }
    return out;
}

// Splits frontmatter from body and returns the body's starting line index, so
// every reported line number is the real one in the file.
function split(text) {
    const lines = text.split('\n');
    if (lines[0] !== '---') return { fm: null, lines, bodyStart: 0 };
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '---') {
            return { fm: lines.slice(1, i).join('\n'), lines, bodyStart: i + 1 };
        }
    }
    return { fm: null, lines, bodyStart: 0 };
}

function declaredTools(fm) {
    if (!fm) return null;
    const m = fm.match(/^allowed-tools:\s*(.*)$/m);
    if (!m) return null;
    return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

// A wildcard declaration covers its namespace; an exact one covers only itself.
function isDeclared(token, declared) {
    for (const d of declared) {
        if (d === token) return true;
        if (d.endsWith('*') && token.startsWith(d.slice(0, -1))) return true;
        if (token.endsWith('*') && d.startsWith(token.slice(0, -1))) return true;
    }
    return false;
}

// The sentence containing an offset, so judgement is scoped to one clause
// rather than a whole paragraph.
function sentenceAround(line, idx) {
    const before = line.slice(0, idx);
    const after = line.slice(idx);
    const e = after.indexOf('. ');
    const tail = e === -1 ? after : after.slice(0, e + 1);

    // Widen past a full stop when what precedes the token is only a fragment.
    // "Use the built-in browser tools. `mcp__Claude_Browser__*`" is one
    // instruction written as two sentences, and reading only the second half
    // loses the verb that makes it one -- a false negative in seven skills.
    let s = before.lastIndexOf('. ');
    let head = s === -1 ? before : before.slice(s + 2);
    if (!/[A-Za-z]{2}/.test(head.replace(/[`*_>#\-\d.)\s]/g, '')) && s !== -1) {
        const s2 = before.slice(0, s).lastIndexOf('. ');
        head = s2 === -1 ? before : before.slice(s2 + 2);
    }
    return head + tail;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function anyOf(hay, needles) { return needles.some((n) => hay.includes(n)); }

// The clause containing the token. Negation is clause-scoped, not sentence-
// scoped, because the corpus is full of "X, never Y" -- "`spawn_task`, never a
// file of prompts" MANDATES the tool and forbids the alternative. Reading that
// negator as applying to the tool inverts the finding, and it hid a real defect
// in `brain` until this was scoped down.
function clauseAround(sentence, token) {
    const at = sentence.indexOf(token);
    if (at === -1) return sentence;
    const parts = [];
    let last = 0;
    for (const m of sentence.matchAll(/[;,]\s|\s—\s|\s--\s/g)) {
        parts.push([last, m.index + m[0].length]);
        last = m.index + m[0].length;
    }
    parts.push([last, sentence.length]);
    for (const [s, e] of parts) if (at >= s && at < e) return sentence.slice(s, e);
    return sentence;
}

// Tool aliases this FILE itself establishes: any `mcp__ns__name` token teaches
// the scan that a backticked `name` in the same file means that tool. Derived
// from the real contract in the document rather than from a hand-written list,
// so it cannot rot as the tool set changes.
function aliasesIn(lines) {
    const map = new Map();
    for (const line of lines) {
        for (const m of line.matchAll(/mcp__[a-zA-Z0-9_]+/g)) {
            const seg = m[0].split('__').pop();
            if (seg && seg.length > 3) map.set(seg, m[0]);
        }
    }
    return map;
}

// TEST 2. Returns the matching mandate class, or null.
function mandateClass(sentence, line, token, prevLines) {
    const s = sentence.toLowerCase();
    const bare = token.replace(/`/g, '');

    // M3 -- a call signature. Checked first: it is the least ambiguous form.
    if (new RegExp(escapeRe(bare) + '`?\\s*[{(]').test(line)) return 'M3';

    // M2 -- the token is the operative content of a procedure step.
    if (new RegExp('^\\s*(?:[-*]|\\d+[.)])\\s*\\**`?' + escapeRe(bare)).test(line)) return 'M2';
    const prev = prevLines[prevLines.length - 1] || '';
    if (/^\s*(?:#{2,6}\s|\**\s*\d+[.)])/.test(prev)
        && new RegExp('^\\s*\\**`?' + escapeRe(bare)).test(line)) return 'M2';

    // M1 -- an imperative verb GOVERNS the token, so it must precede it. A verb
    // form appearing after the token is a noun far more often than not, which is
    // the "Fifty `Bash` calls" false positive.
    const at = s.indexOf(bare.toLowerCase());
    const lead = at === -1 ? s : s.slice(0, at);
    if (anyOf(lead, MANDATE_VERBS.map((v) => v + ' '))) return 'M1';

    return null;
}

// The four negative classes. Returns the class that vetoes, or null.
function negativeClass(sentence, line, token, prevLines, inFence) {
    const s = sentence.toLowerCase();
    const bare = token.replace(/`/g, '');

    // N1 is CLAUSE-scoped; N2 stays sentence-scoped because a conditional
    // ("if the browser tools are unavailable, use `WebFetch`") governs the whole
    // sentence by construction -- the tool sits in the consequent clause.
    if (anyOf(clauseAround(s, bare.toLowerCase()), NEGATORS)) return 'N1';
    if (anyOf(s, CONDITIONALS)) return 'N2';

    // N3 -- the token is the SUBJECT of a descriptive verb about the tool.
    const subj = new RegExp('`?' + escapeRe(bare) + '`?\\s+(?:\\w+\\s+)?(?:'
        + PROPERTY_VERBS.map(escapeRe).join('|') + ')\\s', 'i');
    if (subj.test(sentence)) return 'N3';

    // N4 -- quoted material, introduced by a cue in the nearby preceding prose.
    const isQuoted = inFence || /^\s*>/.test(line) || /^ {4,}\S/.test(line);
    if (isQuoted) {
        const lead = prevLines.slice(-4).join(' ').toLowerCase();
        if (anyOf(lead, QUOTE_CUES)) return 'N4';
    }
    return null;
}

// Scans one file. Returns { skill, declared, refs, findings }.
function scanFile(file) {
    const text = fs.readFileSync(file, 'utf8');
    const { fm, lines, bodyStart } = split(text);
    const declared = declaredTools(fm);
    const skill = path.basename(path.dirname(file));
    const refs = [];
    const aliases = aliasesIn(lines.slice(bodyStart));
    let inFence = false;

    for (let i = bodyStart; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
        const prevLines = lines.slice(Math.max(bodyStart, i - 4), i).filter((l) => l.trim());

        // [token-as-written, offset, canonical-name-for-the-declaration-check]
        const hits = [];
        for (const m of line.matchAll(/mcp__[a-zA-Z0-9_]+\*?/g)) hits.push([m[0], m.index, m[0]]);
        for (const m of line.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)) {
            if (VOCAB.includes(m[1])) hits.push([m[1], m.index, m[1]]);
            else if (aliases.has(m[1])) hits.push([m[1], m.index, aliases.get(m[1])]);
        }

        for (const [token, idx, canonical] of hits) {
            const sentence = sentenceAround(line, idx);
            const mandate = mandateClass(sentence, line, token, prevLines);
            const negative = negativeClass(sentence, line, token, prevLines, inFence);
            refs.push({
                skill, file, line: i + 1, token, canonical, mandate, negative,
                text: line.trim().slice(0, 120),
                declared: declared ? isDeclared(canonical, declared) : false,
            });
        }
    }

    const findings = refs.filter((r) => r.mandate && !r.negative && !r.declared);
    return { skill, file, declared, refs, findings };
}

function scan() {
    const files = walk(PLUGINS);
    return { files, results: files.map(scanFile) };
}

// --------------------------------------------------------------------------
// selftest -- fixtures in BOTH directions, on temp files outside the corpus.
// --------------------------------------------------------------------------
function selftest() {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltool-'));
    const fails = [];
    let total = 0;
    const check = (name, cond) => {
        total++;
        console.log((cond ? '  ok   ' : '  FAIL ') + name);
        if (!cond) fails.push(name);
    };

    const write = (declaredLine, body) => {
        const p = path.join(dir, 'SKILL.md');
        fs.writeFileSync(p, '---\nname: fixture\n' + declaredLine + '\n---\n\n' + body + '\n', 'utf8');
        return scanFile(p);
    };
    const ALLOW = 'allowed-tools: Read, Grep';

    console.log('check-skill-tool-declarations --selftest');
    console.log('\n  MUST FLAG (an undeclared tool the body mandates)');

    let r = write(ALLOW, 'Dispatch with `mcp__ccd_session_mgmt__send_message`, one per session.');
    check('M1 imperative verb + mcp token', r.findings.length === 1);

    r = write(ALLOW, 'Use `WebFetch` to confirm the page loads.');
    check('M1 imperative verb + backticked bare name', r.findings.length === 1);

    r = write(ALLOW, '### 4. Spawn\n\n`mcp__ccd_session__spawn_task` starts the session.');
    check('M2 token under a numbered step heading', r.findings.length === 1);

    r = write(ALLOW, '- `mcp__codex__codex` for the first round.');
    check('M2 token opening a bulleted step', r.findings.length === 1);

    r = write(ALLOW, '```\nmcp__codex__codex { prompt, cwd, model }\n```');
    check('M3 call signature inside a fence', r.findings.length === 1);

    r = write(ALLOW, '> **Browser access.** Use the built-in browser tools. `mcp__Claude_Browser__*`');
    check('an instruction split across two sentences still reads as one',
        r.findings.length === 1);

    r = write(ALLOW, 'Use `mcp__Claude_Browser__navigate` to load it.');
    check('undeclared namespace member flagged', r.findings.length === 1);

    // The short alias, and the "X, never Y" construction, together. Both were
    // needed to see the real defect in `brain`; either alone hides it.
    r = write(ALLOW, 'Spawn the work as chips — `spawn_task`, never a file of prompts.\n\n'
        + 'The tool `mcp__ccd_session__spawn_task` is what puts the chip up.');
    check('short alias of an mcp tool is recognised',
        r.findings.some((f) => f.token === 'spawn_task'));
    check('"X, never Y" mandates X rather than forbidding it',
        r.findings.some((f) => f.mandate === 'M1' && f.token === 'spawn_task'));

    console.log('\n  MUST NOT FLAG (mentions, and correctly declared use)');

    r = write('allowed-tools: Read, Grep, WebFetch', 'Use `WebFetch` to confirm the page loads.');
    check('declared tool, mandated -- clean', r.findings.length === 0);

    r = write('allowed-tools: Read, mcp__Claude_Browser__*',
        'Use `mcp__Claude_Browser__navigate` to load it.');
    check('wildcard declaration covers a member', r.findings.length === 0);

    r = write(ALLOW, 'Do not use `WebFetch` here; it cannot see a rendered page.');
    check('N1 prohibition is not an instruction', r.findings.length === 0);

    r = write(ALLOW, 'Never use `WebFetch` for a page that renders client-side.');
    check('N1 negator in the same clause still vetoes', r.findings.length === 0);

    r = write(ALLOW, '`TodoWrite` are **not available** on Opus 4.8 and newer.');
    check('N1 unavailability notice', r.findings.length === 0);

    r = write(ALLOW, 'Use numbered prose instead; `AskUserQuestion` caps out at four.');
    check('N1 named in order to rule it out', r.findings.length === 0);

    r = write(ALLOW, 'If Context7 tools are available, use `mcp__plugin_context7_context7__query`.');
    check('N2 conditional on availability', r.findings.length === 0);

    r = write(ALLOW, 'If the browser tools are unavailable, use `WebFetch` to check the page loads.');
    check('N2 documented fallback', r.findings.length === 0);

    r = write(ALLOW, '`AskUserQuestion` caps options at 4 per question.');
    check('N3 property claim about a tool', r.findings.length === 0);

    r = write(ALLOW, '`SendMessage` returns success on acceptance by the transport.');
    check('N3 caveat about a tool', r.findings.length === 0);

    r = write(ALLOW, 'The brain skill reads, verbatim:\n\n> Use `mcp__ccd_session__spawn_task` per repo.');
    check('N4 quoting another skill', r.findings.length === 0);

    r = write(ALLOW, 'Fifty `Bash` calls returning a line each are cheap; three `Read` calls are not.');
    check('cost prose naming tools', r.findings.length === 0);

    r = write(ALLOW, 'Read the file, then write the result and edit the task before you run it.');
    check('bare English words are never tool references', r.refs.length === 0);

    console.log('\n  POPULATION FLOOR');
    r = write(ALLOW, 'Nothing here.');
    check('a body with no references yields no findings', r.findings.length === 0 && r.refs.length === 0);
    check('a declared-tools line is parsed', Array.isArray(r.declared) && r.declared.length === 2);

    r = write('name-only: x', 'Use `WebFetch` to confirm the page loads.');
    check('a skill with NO allowed-tools is reported, not skipped', r.declared === null);

    const live = scan();
    check('the live corpus is non-empty', live.files.length > 0);
    check('the live corpus yields references to judge', live.results.some((x) => x.refs.length));

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('\n' + (fails.length ? 'FAIL ' + fails.length : 'PASS')
        + ': ' + (total - fails.length) + '/' + total + ' fixture cases');
    return fails.length ? 1 : 0;
}

// --------------------------------------------------------------------------
function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--selftest')) return selftest();

    const { files, results } = scan();
    const withDecl = results.filter((r) => r.declared !== null);
    const noDecl = results.filter((r) => r.declared === null);
    const refs = results.flatMap((r) => r.refs);
    const findings = results.flatMap((r) => r.findings);

    // Population first, so an empty scan is visible rather than reassuring.
    console.log('skill tool-declaration gate');
    console.log('  ' + files.length + ' skills scanned, ' + withDecl.length
        + ' declare allowed-tools, ' + noDecl.length + ' do not');
    console.log('  ' + refs.length + ' tool references seen, '
        + refs.filter((r) => r.mandate).length + ' read as mandates, '
        + refs.filter((r) => r.negative).length + ' vetoed as mentions');
    console.log('  ' + findings.length + ' flagged\n');

    if (files.length === 0) {
        console.error('read 0 skills, so nothing was checked');
        return 1;
    }

    if (argv.includes('--all')) {
        console.log('every reference seen:');
        for (const r of refs) {
            const verdict = r.declared ? 'declared' : (r.negative || r.mandate || 'inert');
            console.log('  ' + r.skill.padEnd(24) + ':' + String(r.line).padEnd(5)
                + verdict.padEnd(9) + ' ' + r.token);
        }
        console.log('');
    }

    for (const f of findings) {
        const named = f.token === f.canonical ? f.token : f.token + ' (' + f.canonical + ')';
        console.log('  ' + f.mandate + '  ' + f.skill + '/SKILL.md:' + f.line);
        console.log('      mandates ' + named + ', which allowed-tools does not declare');
        console.log('      ' + f.text);
    }

    if (noDecl.length) {
        console.log('\n  ' + noDecl.length + ' skill(s) declare no allowed-tools at all:');
        for (const r of noDecl) console.log('      ' + r.skill);
    }

    console.log('\nlimits: mandate and conditional read per sentence, negation per clause;');
    console.log('bare names counted only in backticks; allowed-tools read as a flat list.');
    console.log('A short alias needs the full mcp__ name in the same file, and 3 real');
    console.log('defects sat in that blind spot on 2026-09-01 (see the header). A clean');
    console.log('run means no DETECTABLE mandate is undeclared, not that none exists.');

    if (argv.includes('--advisory')) return 0;
    return findings.length ? 1 : 0;
}

if (require.main === module) process.exit(main());
module.exports = { scanFile, scan, isDeclared, mandateClass, negativeClass, VOCAB };
