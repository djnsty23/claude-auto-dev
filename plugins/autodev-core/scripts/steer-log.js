#!/usr/bin/env node
/**
 * steer-log.js - grade the overseer's steers instead of recalling them.
 *
 * A "steer" is a message one session sends into another session that is blocked
 * on a question, picking its option and saying why. OVERSEER-PROMPT-LOOP.md
 * defines three metrics for it. This script measures the two that a transcript
 * can honestly answer and refuses to invent the third.
 *
 *   1 STEERS SENT      count + dates. Measured.
 *   2 ARRIVAL LATENCY  did the steer land BEFORE or AFTER the work it
 *                      recommends. Measured, but only for steers whose sender
 *                      call is also on this disk - see THE JOIN below.
 *   3 ADOPTION         did the receiver take the recommendation. NOT MEASURED,
 *                      deliberately. See WHY ADOPTION IS NOT MEASURED.
 *
 * READ-ONLY. It never writes to a transcript and never messages a session.
 *
 * Usage:
 *   node steer-log.js                 # report over every transcript on disk
 *   node steer-log.js --days 7        # only transcripts modified in the last 7d
 *   node steer-log.js --json          # machine-readable
 *   node steer-log.js --evidence      # dump the material for grading adoption BY HAND
 *   node steer-log.js --selftest      # assertions against fixtures; exits 1 on failure
 *
 * Exits 0 for the report (it is a report, never a gate) and 1 only when
 * --selftest fails or the detector cannot fire at all.
 *
 * ---------------------------------------------------------------------------
 * THE MARKER, and how it was verified
 *
 * A message delivered from another session lands in the receiver's transcript
 * as a user-role turn whose text is wrapped in
 *
 *     <cross-session-message from="..." name="..." encoded="1"> ... </cross-session-message>
 *
 * Verified by sending a probe from one session and reading it out of the
 * receiver's file: the sender's `mcp__ccd_session_mgmt__send_message` input
 * appears verbatim inside that wrapper in the receiver's transcript.
 *
 * The structured field `origin.kind === "peer"` looks like the cleaner marker
 * and IS NOT USED as the primary test, because it is version-dependent: CLI
 * 2.1.237 writes {"kind":"peer",...} and 2.1.219 wrote {"kind":"human"} for the
 * exact same delivery. Keying on "peer" silently drops every steer older than
 * a few weeks - measured on this corpus, 7 of 18. The wrapper tag is stable
 * across every version present.
 *
 * Two shapes that must NOT be counted, both real and both present on disk:
 *   - the host writes a twin {"type":"queue-operation","operation":"enqueue"}
 *     record carrying the same text ~0.1-0.5s before the user turn. Counting it
 *     doubles every steer.
 *   - a hook_success attachment, a memory note, or ordinary prose can quote the
 *     tag. Hence: the turn must be user-role, the tag must sit within the first
 *     MAX_PREFIX characters, and it must be closed.
 *
 * ---------------------------------------------------------------------------
 * THE JOIN, and why arrival latency needs it
 *
 * The receiver's transcript does not record when the steer was SENT. The
 * queue-operation twin is written when the queue DRAINS, not when the sender
 * called the tool - measured at 14 minutes apart on one real steer
 * (sent 19:16:57.892Z, enqueued 19:30:57.869Z). So latency is only computable
 * where the sender's transcript is also on this disk. Steers that arrived over
 * the named-pipe transport (origin.from = "uds:\\.\pipe\cc-msg-...") have no
 * send_message tool call at all and are reported as NOT MEASURED rather than
 * as on-time.
 *
 * Steers are joined sender->receiver on a hash of the message body, which is
 * byte-identical on both sides. The desktop session index is used only as a
 * tie-breaker and for display names.
 *
 * ---------------------------------------------------------------------------
 * WHY ADOPTION IS NOT MEASURED
 *
 * Adoption means "the receiver's subsequent actions are consistent with the
 * recommendation". Every mechanical proxy available here measures something
 * else and would report it confidently:
 *   - "the receiver took a turn afterwards" measures delivery, not agreement;
 *     a session that read the steer and rejected it scores identically.
 *   - "the receiver's next tool calls mention words from the steer" measures
 *     vocabulary overlap. Steers quote file paths the session was already
 *     working in, so it would score high on a steer that was ignored.
 *   - "the receiver did what the steer said" needs the steer's recommendation
 *     extracted from prose and compared against intent. That is a judgement,
 *     not a parse.
 * A number here would be confident and wrong, which is worse than no number.
 * So this script reports adoption as not-measured and, under --evidence, prints
 * the raw material - the steer body and the receiver's next actions - for a
 * human or a model to grade. Preparing the grading packet is honest; grading it
 * mechanically is not.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');

const HOME = process.env.USERPROFILE || process.env.HOME;
const ROOT = path.join(HOME, '.claude', 'projects');

// REUSE, not re-implementation: fleet-status.js already solves the transcript
// <-> desktop-session join (cliSessionId -> local_<uuid> -> title, cwd) and
// already knows where the desktop store lives. Requiring it is safe - its
// main() is guarded by require.main.
let loadSessionIndex = () => new Map();
try {
    const fleet = require(path.join(__dirname, 'fleet-status.js'));
    if (typeof fleet.loadSessionIndex === 'function') loadSessionIndex = fleet.loadSessionIndex;
} catch { /* index is a nicety; every metric below works without it */ }

// ---------------------------------------------------------------------------
// Detection

const MARKER = 'cross-session-message';
const OPEN_TAG = /<cross-session-message\b([^>]*)>/;
const CLOSE_TAG = '</cross-session-message>';

// The newer CLI prefixes the wrapper with "Another Claude session sent a
// message:\n" (39 chars); older builds put it at index 0. 200 leaves room for a
// longer prefix in a future build while still rejecting a tag quoted mid-prose.
const MAX_PREFIX = 200;

/** Flatten a message content field to its human text. Non-text parts are dropped
 *  on purpose: a tool_result echoing the tag is not a delivered steer. */
function extractText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const out = [];
    for (const p of content) {
        if (p && p.type === 'text' && typeof p.text === 'string') out.push(p.text);
    }
    return out.join('\n');
}

function attr(raw, name) {
    const m = new RegExp(name + '="([^"]*)"').exec(raw || '');
    return m ? m[1] : null;
}

/**
 * @returns {{from:string,name:string,body:string,bodyHash:string}|null}
 */
function detectDeliveredSteer(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const role = rec.message && rec.message.role;
    // User-role turn only. This is what separates the delivery from its
    // queue-operation twin and from an assistant quoting the tag back.
    if (rec.type !== 'user' && role !== 'user') return null;
    if (!rec.message) return null;

    const text = extractText(rec.message.content);
    if (!text) return null;
    const m = OPEN_TAG.exec(text);
    if (!m || m.index > MAX_PREFIX) return null;
    const start = m.index + m[0].length;
    const end = text.indexOf(CLOSE_TAG, start);
    if (end < 0) return null;

    const body = text.slice(start, end).trim();
    return {
        from: attr(m[1], 'from') || 'unknown',
        name: attr(m[1], 'name') || null,
        body,
        bodyHash: hash(body),
    };
}

/** Sender side: cross-session send calls. */
function detectSends(rec) {
    const out = [];
    const c = rec && rec.message && rec.message.content;
    if (!Array.isArray(c)) return out;
    for (const p of c) {
        if (!p || p.type !== 'tool_use') continue;
        // The MCP cross-session tool. Deliberately NOT the Agent-thread
        // `SendMessage` tool, which talks to a subagent and is not a steer.
        if (!/(^|__)send_message$/.test(p.name || '')) continue;
        const inp = p.input || {};
        if (typeof inp.message !== 'string' || !inp.message.trim()) continue;
        out.push({
            toolUseId: p.id || null,
            target: inp.session_id || null,
            body: inp.message.trim(),
            bodyHash: hash(inp.message.trim()),
        });
    }
    return out;
}

/** The host's own verdict, read off the send tool_result. Absent -> null, never
 *  false: an unrecognised wording must not fall through to "arrived promptly". */
function detectSendResult(rec) {
    const c = rec && rec.message && rec.message.content;
    if (!Array.isArray(c)) return null;
    for (const p of c) {
        if (!p || p.type !== 'tool_result' || !p.tool_use_id) continue;
        const t = extractText(p.content) || (typeof p.content === 'string' ? p.content : '');
        if (/Message queued for session/i.test(t)) return { id: p.tool_use_id, hostQueued: true };
        if (/Message sent to session/i.test(t)) return { id: p.tool_use_id, hostQueued: false };
    }
    return null;
}

function hash(s) { return crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 16); }

// ---------------------------------------------------------------------------
// "Substantive action" - the definition the latency metric turns on.
//
// A substantive action is an assistant tool_use whose effect CANNOT BE DISCARDED
// FOR FREE: it writes to disk, runs a command, delegates to a subagent, or
// mutates remote state. Write, Edit, Bash, Task, git, deploys, MCP mutations.
//
// Reads are excluded on purpose - Read, Grep, Glob, WebFetch, ToolSearch, and
// AskUserQuestion do not count as work.
//
// The defence: the metric asks whether the steer could still change the outcome.
// After a grep, redirecting costs nothing; the grep is simply discarded. After
// an Edit or a Bash, redirecting costs a revert or a re-run - which is exactly
// the failure OVERSEER-PROMPT-LOOP.md names, "a late steer is not neutral: it
// costs the receiver a re-read and can contradict what it just did". Putting the
// boundary at write/execute makes the metric CONSERVATIVE IN THE RIGHT
// DIRECTION: it will never call a steer late merely because the receiver was
// looking things up, so a LATE verdict always corresponds to real rework.
//
// AskUserQuestion is explicitly read-only: a session sitting on an open panel is
// the ideal moment to steer, not evidence that the steer was too late.
//
// Anything not on the read-only list counts as substantive, because an
// unrecognised tool must fall to the DANGEROUS reading ("work happened"), never
// to the comfortable one. The distinct names actually counted are printed with
// the report so the classification is auditable rather than asserted.
const READ_ONLY_TOOLS = new Set([
    'Read', 'NotebookRead', 'Grep', 'Glob', 'LS', 'TodoWrite', 'ToolSearch',
    'WebFetch', 'WebSearch', 'AskUserQuestion', 'ExitPlanMode', 'Skill',
    'SlashCommand', 'BashOutput', 'KillShell', 'Monitor', 'ListMcpResources',
    'ReadMcpResource', 'ListPlugins', 'ListSkills', 'SearchPlugins', 'SearchSkills',
]);
// Documented heuristic, not a guess dressed as a rule: MCP tools whose verb is a
// read verb are treated as reads. Any name it does not match stays substantive.
const MCP_READ_VERB = /^mcp__.*__(list|get|read|search|find|fetch|describe)(_|$)/;

function isSubstantive(toolName) {
    if (!toolName) return false;
    if (READ_ONLY_TOOLS.has(toolName)) return false;
    if (MCP_READ_VERB.test(toolName)) return false;
    return true;
}

// ---------------------------------------------------------------------------
// Scanning

const TS_RE = /"timestamp":"([^"]{10,40})"/;

function listTranscripts(root, cutoffMs) {
    const files = [];
    const walk = (dir, depth) => {
        // Transcripts nest three ways: <proj>/x.jsonl, <proj>/<uuid>/subagents/x.jsonl,
        // and <proj>/<uuid>/subagents/workflows/wf_*/x.jsonl. A depth of 4 silently
        // dropped 113 of 593 files - a denominator that is wrong in the direction
        // of under-reporting, which is exactly what the population line exists to
        // prevent. Subagent transcripts matter: they have leaked secrets before.
        if (depth > 8) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p, depth + 1); continue; }
            if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
            let st; try { st = fs.statSync(p); } catch { continue; }
            if (cutoffMs && st.mtimeMs < cutoffMs) continue;
            files.push({ file: p, bytes: st.size });
        }
    };
    walk(root, 0);
    return files;
}

/**
 * Pass 1 over one transcript. Streams line by line and JSON.parses only the
 * lines that could possibly matter - these files run to 368 MB on this machine
 * and readFileSync would not survive one of them.
 *
 * @returns {{ok:boolean, error:string|null, badLines:number, steers:[], sends:[]}}
 */
async function scanFile(file) {
    const res = { ok: true, error: null, badLines: 0, steers: [], sends: [] };
    let stream;
    try {
        stream = fs.createReadStream(file, { encoding: 'utf8' });
    } catch (e) {
        return { ...res, ok: false, error: String(e.message || e) };
    }
    const pending = new Map();      // toolUseId -> send record awaiting its result
    try {
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line) continue;
            const maybeSteer = line.indexOf(MARKER) >= 0;
            const maybeSend = line.indexOf('send_message') >= 0;
            const maybeResult = line.indexOf('Message queued for session') >= 0
                || line.indexOf('Message sent to session') >= 0;
            if (!maybeSteer && !maybeSend && !maybeResult) continue;

            let rec;
            try { rec = JSON.parse(line); } catch { res.badLines++; continue; }

            if (maybeSteer) {
                const s = detectDeliveredSteer(rec);
                if (s) {
                    res.steers.push({
                        ...s,
                        deliveredAt: rec.timestamp || null,
                        recipientSession: rec.sessionId || null,
                        recipientCwd: rec.cwd || null,
                        recipientBranch: rec.gitBranch || null,
                        originKind: (rec.origin && rec.origin.kind) || null,
                        cliVersion: rec.version || null,
                        file,
                    });
                }
            }
            if (maybeSend) {
                for (const snd of detectSends(rec)) {
                    const entry = {
                        ...snd,
                        sentAt: rec.timestamp || null,
                        senderSession: rec.sessionId || null,
                        senderCwd: rec.cwd || null,
                        hostQueued: null,
                        file,
                    };
                    res.sends.push(entry);
                    if (entry.toolUseId) pending.set(entry.toolUseId, entry);
                }
            }
            if (maybeResult) {
                const r = detectSendResult(rec);
                if (r && pending.has(r.id)) pending.get(r.id).hostQueued = r.hostQueued;
            }
        }
    } catch (e) {
        res.ok = false;
        res.error = String(e.message || e);
    }
    return res;
}

/**
 * Pass 2: collect the receiver's tool calls inside the time windows a joined
 * steer needs. Only runs on files that produced a steer, and only parses lines
 * whose timestamp already falls inside a window.
 */
async function collectActions(file, windows) {
    const hits = [];
    if (!windows.length) return hits;
    const lo = Math.min(...windows.map((w) => w.from));
    const hi = Math.max(...windows.map((w) => w.to));
    let stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); } catch { return hits; }
    try {
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line || line.indexOf('"tool_use"') < 0) continue;
            const tm = TS_RE.exec(line);
            if (!tm) continue;
            const t = Date.parse(tm[1]);
            if (!(t >= lo && t <= hi)) continue;
            let rec; try { rec = JSON.parse(line); } catch { continue; }
            if (rec.isSidechain) continue;                 // subagent noise, not this session's own hands
            const c = rec.message && rec.message.content;
            if (!Array.isArray(c)) continue;
            for (const p of c) {
                if (!p || p.type !== 'tool_use') continue;
                hits.push({ t, name: p.name || '?', substantive: isSubstantive(p.name) });
            }
        }
    } catch { /* partial is better than nothing; the population line says what was read */ }
    return hits;
}

// ---------------------------------------------------------------------------

const POST_WINDOW_MS = 2 * 3600 * 1000;   // how far after delivery to gather evidence
const MAX_EVIDENCE = 8;

async function scanCorpus(opts) {
    const root = opts.root || ROOT;
    const cutoff = opts.days ? Date.now() - opts.days * 864e5 : 0;

    const population = {
        root,
        transcripts: 0,
        bytes: 0,
        unreadable: 0,
        badLines: 0,
        withSteers: 0,
        withSends: 0,
        steersDelivered: 0,
        sendCalls: 0,
    };

    if (!fs.existsSync(root)) return { population, steers: [], sends: [], unreadableFiles: [] };

    const files = listTranscripts(root, cutoff);
    population.transcripts = files.length;

    const steers = [];
    const sends = [];
    const unreadableFiles = [];

    for (const { file, bytes } of files) {
        population.bytes += bytes;
        const r = await scanFile(file);
        population.badLines += r.badLines;
        if (!r.ok) { population.unreadable++; unreadableFiles.push({ file, error: r.error }); continue; }
        if (r.steers.length) population.withSteers++;
        if (r.sends.length) population.withSends++;
        steers.push(...r.steers);
        sends.push(...r.sends);
    }

    population.steersDelivered = steers.length;
    population.sendCalls = sends.length;

    steers.sort((a, b) => String(a.deliveredAt).localeCompare(String(b.deliveredAt)));
    sends.sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));

    return { population, steers, sends, unreadableFiles };
}

/** Join each delivered steer to the send call that produced it. */
function joinSteers(steers, sends, index) {
    const byHash = new Map();
    for (const s of sends) {
        if (!byHash.has(s.bodyHash)) byHash.set(s.bodyHash, []);
        byHash.get(s.bodyHash).push(s);
    }
    // local_<uuid> -> cliSessionId, so a multi-recipient broadcast can be split.
    const localToCli = new Map();
    for (const [cli, rec] of index.entries()) {
        if (rec && rec.addressableId) localToCli.set(rec.addressableId, cli);
    }

    for (const st of steers) {
        const cands = byHash.get(st.bodyHash) || [];
        let picked = null, method = 'none';
        if (cands.length === 1) {
            picked = cands[0]; method = 'body-hash';
        } else if (cands.length > 1) {
            const mine = cands.filter((c) => c.target && localToCli.get(c.target) === st.recipientSession);
            const pool = mine.length ? mine : cands;
            const before = pool.filter((c) => Date.parse(c.sentAt) <= Date.parse(st.deliveredAt));
            picked = (before.length ? before : pool)[before.length ? before.length - 1 : 0];
            method = mine.length ? 'body-hash+recipient' : 'body-hash+nearest';
        }
        st.join = method;
        st.sentAt = picked ? picked.sentAt : null;
        st.senderSession = picked ? picked.senderSession : null;
        st.hostQueued = picked ? picked.hostQueued : null;
        st.queueMs = picked && st.deliveredAt
            ? Date.parse(st.deliveredAt) - Date.parse(picked.sentAt)
            : null;
    }
    return steers;
}

async function measureLatency(steers) {
    // Group the windows we need by receiver file, so each big transcript is
    // re-read at most once.
    const byFile = new Map();
    for (const st of steers) {
        const d = Date.parse(st.deliveredAt);
        if (!Number.isFinite(d)) continue;
        const from = st.sentAt ? Date.parse(st.sentAt) : d;
        const w = { from: Math.min(from, d), to: d + POST_WINDOW_MS };
        if (!byFile.has(st.file)) byFile.set(st.file, []);
        byFile.get(st.file).push(w);
    }
    const actionsByFile = new Map();
    for (const [file, windows] of byFile.entries()) {
        actionsByFile.set(file, await collectActions(file, windows));
    }

    const counted = new Map();     // tool name -> times counted as substantive
    for (const st of steers) {
        const acts = actionsByFile.get(st.file) || [];
        const d = Date.parse(st.deliveredAt);

        // AFTER-delivery material. Always available, used only as evidence.
        st.after = acts.filter((a) => a.t >= d && a.t <= d + POST_WINDOW_MS)
            .sort((a, b) => a.t - b.t).slice(0, MAX_EVIDENCE)
            .map((a) => ({ at: new Date(a.t).toISOString(), tool: a.name, substantive: a.substantive }));

        if (!st.sentAt) {
            st.latency = 'not-measured';
            st.latencyReason = 'no send call for this steer is on this disk (' + (st.originKind || 'unknown origin') + ')';
            st.workInWindow = null;
            continue;
        }
        const s = Date.parse(st.sentAt);
        const inWindow = acts.filter((a) => a.t > s && a.t < d);
        const subs = inWindow.filter((a) => a.substantive);
        for (const a of subs) counted.set(a.name, (counted.get(a.name) || 0) + 1);
        st.workInWindow = { tools: inWindow.length, substantive: subs.length, names: [...new Set(subs.map((a) => a.name))] };
        st.latency = subs.length ? 'LATE' : 'IN-TIME';
        st.latencyReason = subs.length
            ? subs.length + ' substantive action(s) ran between send and delivery'
            : 'no substantive action ran between send and delivery';
    }
    return { substantiveNames: counted };
}

// ---------------------------------------------------------------------------
// Known-positive control.
//
// A zero from this detector is far more likely to be a broken detector than an
// empty world, so the detector must prove it CAN fire before any count is
// believed. The fixture is a verbatim-shape copy of a real delivered record.

const KNOWN_POSITIVE = {
    type: 'user',
    message: {
        role: 'user',
        content: 'Another Claude session sent a message:\n<cross-session-message from="local_0000" name="known positive" encoded="1">\ntake option 2, because the migration already exists\n</cross-session-message>\n\nThis came from another Claude session.',
    },
    isMeta: true,
    timestamp: '2026-08-21T19:30:58.360Z',
    sessionId: 'fixture',
    origin: { kind: 'peer', from: 'local_0000', hostInjected: true },
};

function controlFires() { return !!detectDeliveredSteer(KNOWN_POSITIVE); }

// ---------------------------------------------------------------------------
// Report

function short(s, n) {
    if (!s) return '';
    const one = String(s).replace(/\s+/g, ' ').trim();
    return one.length > n ? one.slice(0, n - 1) + '…' : one;
}
function day(ts) { return ts ? String(ts).slice(0, 10) : '?'; }
function mb(b) { return (b / 1048576).toFixed(1); }

function label(index, sessionId, cwd) {
    const rec = index.get(sessionId);
    if (rec && rec.title) return rec.title;
    if (cwd) return cwd.split(/[\\/]/).slice(-1)[0];
    return sessionId ? sessionId.slice(0, 8) : '?';
}

async function report(opts) {
    const index = loadSessionIndex();
    const { population, steers, sends, unreadableFiles } = await scanCorpus(opts);
    joinSteers(steers, sends, index);
    const { substantiveNames } = await measureLatency(steers);

    const measured = steers.filter((s) => s.latency !== 'not-measured');
    const late = steers.filter((s) => s.latency === 'LATE');
    const inTime = steers.filter((s) => s.latency === 'IN-TIME');
    const hostQueued = steers.filter((s) => s.hostQueued === true);
    const byDay = new Map();
    for (const s of steers) byDay.set(day(s.deliveredAt), (byDay.get(day(s.deliveredAt)) || 0) + 1);

    // A lower bound, not a rate: steers whose text self-flags a correction of an
    // earlier steer. It is a literal string search and is reported as such.
    const CORRECTION = /(correction to my previous|\bi was wrong\b|correcting my earlier|ignore my (?:previous|last) message|retract)/i;
    const corrections = steers.filter((s) => CORRECTION.test(s.body));

    if (opts.json) {
        console.log(JSON.stringify({
            scannedAt: new Date().toISOString(),
            population: {
                ...population,
                controlFires: controlFires(),
                latencyMeasured: measured.length,
                latencyNotMeasured: steers.length - measured.length,
                adoptionMeasured: 0,
            },
            byDay: [...byDay.entries()].sort().map(([d, n]) => ({ date: d, steers: n })),
            substantiveToolsCounted: [...substantiveNames.entries()].sort((a, b) => b[1] - a[1]),
            selfFlaggedCorrections: corrections.length,
            unreadableFiles,
            steers: steers.map((s) => ({
                deliveredAt: s.deliveredAt,
                sentAt: s.sentAt,
                queueMs: s.queueMs,
                hostQueued: s.hostQueued,
                join: s.join,
                latency: s.latency,
                latencyReason: s.latencyReason,
                workInWindow: s.workInWindow,
                adoption: 'not-measured',
                adoptionReason: 'no honest mechanical proxy; see header comment',
                from: s.from,
                fromName: s.name,
                originKind: s.originKind,
                recipient: label(index, s.recipientSession, s.recipientCwd),
                recipientSession: s.recipientSession,
                recipientBranch: s.recipientBranch,
                firstLine: short(s.body.split('\n')[0], 160),
                bodyChars: s.body.length,
                after: opts.evidence ? s.after : undefined,
                body: opts.evidence ? s.body : undefined,
            })),
        }, null, 2));
        return steers.length ? 0 : 1;
    }

    console.log('steer-log — cross-session steer measurement');
    console.log('scanned ' + new Date().toISOString() + (opts.days ? '  (last ' + opts.days + 'd)' : '  (all time)'));
    console.log('');

    // A findings list with no denominator cannot be judged.
    console.log('POPULATION');
    console.log('  transcripts scanned          ' + population.transcripts + '  (' + mb(population.bytes) + ' MB)');
    console.log('  unreadable                   ' + population.unreadable);
    console.log('  lines that failed to parse   ' + population.badLines);
    console.log('  files with >=1 steer         ' + population.withSteers);
    console.log('  files with >=1 send call     ' + population.withSends);
    console.log('  steers DELIVERED             ' + population.steersDelivered);
    console.log('  send_message calls found     ' + population.sendCalls);
    console.log('  root                         ' + population.root);
    for (const u of unreadableFiles) console.log('    ! ' + u.file + '  ' + u.error);
    console.log('');

    console.log('KNOWN-POSITIVE CONTROL');
    console.log('  detector fires on fixture    ' + (controlFires() ? 'YES' : 'NO'));
    if (!controlFires()) {
        console.log('  ** THE DETECTOR IS BROKEN. Every count below is meaningless. **');
        return 1;
    }
    if (!steers.length) {
        console.log('');
        console.log('  ZERO steers found across ' + population.transcripts + ' transcripts.');
        console.log('  The fixture fires, so the detector works on the shape it knows - but a');
        console.log('  corpus-wide zero is still far more likely to be a marker that changed');
        console.log('  than a world with no steers in it. Treat this as UNVERIFIED, not as 0.');
        return 1;
    }
    const first = steers[0];
    console.log('  first real steer on disk     ' + first.deliveredAt);
    console.log('    from ' + first.from + (first.name ? ' ("' + first.name + '")' : ''));
    console.log('    to   ' + label(index, first.recipientSession, first.recipientCwd) + '  [' + first.recipientSession + ']');
    console.log('    text ' + short(first.body, 140));
    console.log('');

    console.log('1  STEERS SENT — MEASURED');
    console.log('   ' + population.steersDelivered + ' delivered, ' + population.sendCalls + ' send calls found on disk');
    for (const [d, n] of [...byDay.entries()].sort()) console.log('     ' + d + '  ' + n);
    console.log('');

    console.log('2  ARRIVAL LATENCY — MEASURED for ' + measured.length + ' of ' + steers.length);
    console.log('   LATE (work ran between send and delivery)   ' + late.length);
    console.log('   IN-TIME                                     ' + inTime.length);
    console.log('   not measured (no send call on this disk)    ' + (steers.length - measured.length));
    console.log('   host itself reported the receiver busy      ' + hostQueued.length
        + (hostQueued.length ? ' ("Message queued ... after the in-flight turn finishes")' : ''));
    if (substantiveNames.size) {
        console.log('   tools counted as substantive in windows:    '
            + [...substantiveNames.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => n + '(' + c + ')').join(' '));
    }
    console.log('');

    console.log('3  ADOPTION — NOT MEASURED (0 of ' + steers.length + ')');
    console.log('   No mechanical proxy measures agreement: "took a turn afterwards" measures');
    console.log('   delivery, and keyword overlap scores high on steers that were ignored.');
    console.log('   Run --evidence to dump the grading packet and grade it by hand.');
    console.log('');

    console.log('   self-flagged corrections in steer text: ' + corrections.length
        + '  (literal string search, a LOWER BOUND on wrong steers - not an accuracy rate)');
    for (const c of corrections) console.log('     ' + day(c.deliveredAt) + '  ' + short(c.body, 100));
    console.log('');

    console.log('STEERS');
    console.log('  ' + 'delivered'.padEnd(21) + 'latency'.padEnd(13) + 'queue'.padEnd(9) + 'recipient');
    for (const s of steers) {
        const q = s.queueMs == null ? '-' : (s.queueMs >= 60000 ? Math.round(s.queueMs / 60000) + 'm' : Math.round(s.queueMs / 1000) + 's');
        console.log('  ' + String(s.deliveredAt).replace('T', ' ').slice(0, 19).padEnd(21)
            + String(s.latency).padEnd(13)
            + q.padEnd(9)
            + short(label(index, s.recipientSession, s.recipientCwd), 34));
        console.log('      "' + short(s.body.split('\n')[0], 110) + '"');
        if (s.latency === 'LATE') console.log('      ! ' + s.latencyReason + ': ' + s.workInWindow.names.join(', '));
        if (s.latency === 'not-measured') console.log('      ? ' + s.latencyReason);
        if (opts.evidence) {
            console.log('      --- EVIDENCE FOR MANUAL GRADING (this tool does not grade adoption) ---');
            console.log('      steer: ' + short(s.body, 600));
            if (!s.after.length) console.log('      next actions: none within 2h');
            for (const a of s.after) console.log('      next: ' + a.at.slice(11, 19) + '  ' + a.tool + (a.substantive ? '  [substantive]' : ''));
        }
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Selftest
//
// Every assertion below must be capable of failing. The ones that only prove a
// detector CAN fire are paired with a negative that proves it does not fire on
// the lookalike, because a selftest that only plants positives cannot tell a
// working detector from one that returns true for everything.

async function selftest() {
    // Assertions are QUEUED and then awaited in order. An earlier version ran
    // `ok = !!fn()` inline, which coerced a promise to true and made every async
    // assertion vacuously green - the exact failure this harness exists to
    // catch. Requiring `=== true` also means an assertion that returns undefined
    // (a forgotten return) fails instead of silently passing.
    const queue = [];
    const check = (name, fn) => queue.push({ name, fn });

    // --- positives: every record shape that really occurs on disk -----------
    check('fires on the current format (peer origin, string content, 39-char prefix)', () => {
        const r = detectDeliveredSteer(KNOWN_POSITIVE);
        return r && r.from === 'local_0000' && r.body === 'take option 2, because the migration already exists';
    });

    check('fires on the 2.1.219 format (origin.kind "human", tag at index 0)', () => {
        const r = detectDeliveredSteer({
            type: 'user',
            message: { role: 'user', content: '<cross-session-message from="local_old" name="older build" encoded="1">\nBranch ready to merge\n</cross-session-message>' },
            origin: { kind: 'human' },
            timestamp: '2026-08-02T09:55:14.392Z',
        });
        return r && r.from === 'local_old' && r.body === 'Branch ready to merge';
    });

    check('fires when content is an array of text parts', () => {
        const r = detectDeliveredSteer({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: '<cross-session-message from="local_arr">\nuse the existing bar\n</cross-session-message>' }] },
        });
        return r && r.body === 'use the existing bar';
    });

    check('fires on the named-pipe transport (origin.from is a uds pipe)', () => {
        const r = detectDeliveredSteer({
            type: 'user',
            message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="uds:\\\\.\\pipe\\cc-msg-abc" name="autodev-15" encoded="1">\nyour version picture is out of date\n</cross-session-message>' },
            origin: { kind: 'peer', from: 'uds:\\\\.\\pipe\\cc-msg-abc' },
        });
        return r && /^uds:/.test(r.from);
    });

    // --- negatives: the lookalikes that are really on disk -------------------
    check('does NOT fire on the queue-operation enqueue twin (would double every steer)', () => {
        return detectDeliveredSteer({
            type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-21T19:30:57.869Z',
            sessionId: 'x', content: '<cross-session-message from="local_0000">\nbody\n</cross-session-message>',
        }) === null;
    });

    check('does NOT fire on a hook_success attachment quoting the tag', () => {
        return detectDeliveredSteer({
            type: 'attachment',
            attachment: { type: 'hook_success', stdout: '[Memory] Fixed Terms.tsx: <cross-session-message from="local_x" name="backlog' },
        }) === null;
    });

    check('does NOT fire when the tag is quoted deep in prose (MAX_PREFIX guard)', () => {
        const prose = 'x'.repeat(900) + '<cross-session-message from="local_q">\nq\n</cross-session-message>';
        return detectDeliveredSteer({ type: 'user', message: { role: 'user', content: prose } }) === null;
    });

    check('does NOT fire on an unclosed tag', () => {
        return detectDeliveredSteer({
            type: 'user',
            message: { role: 'user', content: '<cross-session-message from="local_u">\nno closing tag here' },
        }) === null;
    });

    check('does NOT fire on an assistant turn quoting the tag back', () => {
        return detectDeliveredSteer({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: '<cross-session-message from="local_a">\nx\n</cross-session-message>' }] },
        }) === null;
    });

    check('does NOT fire on the tag inside a tool_result part of a user turn', () => {
        return detectDeliveredSteer({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '<cross-session-message from="local_tr">\nx\n</cross-session-message>' }] },
        }) === null;
    });

    // --- send side -----------------------------------------------------------
    check('detects the MCP send_message call and its body', () => {
        const s = detectSends({
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__ccd_session_mgmt__send_message', input: { session_id: 'local_z', message: 'take option 2' } }] },
        });
        return s.length === 1 && s[0].target === 'local_z' && s[0].body === 'take option 2';
    });

    check('does NOT treat the subagent SendMessage tool as a steer', () => {
        return detectSends({
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'SendMessage', input: { session_id: 'x', message: 'hi agent' } }] },
        }).length === 0;
    });

    check('the body hash joins sender to receiver (same text, both sides)', () => {
        const body = 'take option 2, because the migration already exists';
        const sent = detectSends({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 'i', name: 'mcp__ccd_session_mgmt__send_message', input: { session_id: 'local_0000', message: body } }] } })[0];
        const got = detectDeliveredSteer(KNOWN_POSITIVE);
        return sent.bodyHash === got.bodyHash;
    });

    check('host verdict reads "queued" as busy and "sent" as prompt, unknown wording as null', () => {
        const busy = detectSendResult({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'Message queued for session local_x ("t"); it will be processed after the in-flight turn finishes' }] }] } });
        const prompt = detectSendResult({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'Message sent to session local_x ("t").' }] }] } });
        const unknown = detectSendResult({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: 'Delivered eventually maybe' }] }] } });
        return busy && busy.hostQueued === true && prompt && prompt.hostQueued === false && unknown === null;
    });

    // --- the substantive-action definition -----------------------------------
    check('substantive: Bash/Edit/Write/Task yes, Read/Grep/AskUserQuestion no', () => {
        return ['Bash', 'Edit', 'Write', 'Task', 'NotebookEdit'].every(isSubstantive)
            && !['Read', 'Grep', 'Glob', 'WebFetch', 'AskUserQuestion', 'TodoWrite'].some(isSubstantive);
    });

    check('an unrecognised tool falls to SUBSTANTIVE, the dangerous reading', () => {
        return isSubstantive('SomeToolInventedNextMonth') === true;
    });

    check('an MCP read verb is not substantive, an MCP write verb is', () => {
        return isSubstantive('mcp__ccd_session_mgmt__list_sessions') === false
            && isSubstantive('mcp__ccd_session_mgmt__send_message') === true;
    });

    // --- the latency verdict itself ------------------------------------------
    const latencyCase = (toolsBetween) => {
        const st = {
            file: 'F', deliveredAt: '2026-08-21T10:10:00.000Z', sentAt: '2026-08-21T10:00:00.000Z',
            originKind: 'peer', body: 'b',
        };
        const acts = toolsBetween.map((n, i) => ({ t: Date.parse('2026-08-21T10:0' + (i + 1) + ':00.000Z'), name: n, substantive: isSubstantive(n) }));
        // inline the same arithmetic measureLatency uses
        const s = Date.parse(st.sentAt), d = Date.parse(st.deliveredAt);
        const subs = acts.filter((a) => a.t > s && a.t < d && a.substantive);
        return subs.length ? 'LATE' : 'IN-TIME';
    };
    check('a Bash between send and delivery makes the steer LATE', () => latencyCase(['Bash']) === 'LATE');
    check('only reads between send and delivery leaves it IN-TIME', () => latencyCase(['Read', 'Grep', 'Glob']) === 'IN-TIME');
    check('an AskUserQuestion in the window does not make it LATE', () => latencyCase(['AskUserQuestion']) === 'IN-TIME');

    // --- adoption must stay unmeasured ---------------------------------------
    check('adoption is reported as the not-measured sentinel, never a number', () => {
        const src = fs.readFileSync(__filename, 'utf8');
        // The key is assembled at runtime so this assertion does not match its
        // own source - it did, and reported the regex literal as an emitted
        // value. A grep-the-source check has to exclude the grep.
        const re = new RegExp('adoption' + ':\\s*([^,\\n]+)', 'g');
        const emitted = [...src.matchAll(re)].map((m) => m[1].trim());
        return emitted.length > 0 && emitted.every((v) => v === "'not-measured'");
    });

    // --- population machinery, against a fixture corpus -----------------------
    // Three files: one carrying a real-shape steer AND its enqueue twin AND an
    // unparseable line, one ordinary, one sender-side. If the denominator
    // machinery is wrong - double-counting the twin, swallowing the bad line,
    // missing a subdirectory - these numbers move.
    check('population counts transcripts, files-with-steers and unparseable lines', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steer-selftest-'));
        try {
            const proj = path.join(dir, 'proj-a');
            fs.mkdirSync(proj);
            fs.writeFileSync(path.join(proj, 'has-steer.jsonl'), [
                JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '<cross-session-message from="local_0000">\nb\n</cross-session-message>' }),
                JSON.stringify(KNOWN_POSITIVE),
                '{ this line is not json but it does mention cross-session-message',
            ].join('\n'), 'utf8');
            fs.writeFileSync(path.join(proj, 'no-steer.jsonl'),
                JSON.stringify({ type: 'user', message: { role: 'user', content: 'ordinary turn' } }), 'utf8');
            fs.writeFileSync(path.join(proj, 'sender.jsonl'),
                JSON.stringify({ type: 'assistant', timestamp: '2026-08-21T19:00:00.000Z', sessionId: 'snd', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'i', name: 'mcp__ccd_session_mgmt__send_message', input: { session_id: 'local_0000', message: 'take option 2, because the migration already exists' } }] } }), 'utf8');

            const { population: p } = await scanCorpus({ root: dir });
            return p.transcripts === 3 && p.withSteers === 1 && p.steersDelivered === 1
                && p.withSends === 1 && p.sendCalls === 1 && p.badLines === 1 && p.unreadable === 0;
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
        }
    });

    check('the join links a fixture sender to a fixture receiver and sets sentAt', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steer-join-'));
        try {
            fs.writeFileSync(path.join(dir, 'r.jsonl'), JSON.stringify(KNOWN_POSITIVE), 'utf8');
            fs.writeFileSync(path.join(dir, 's.jsonl'),
                JSON.stringify({ type: 'assistant', timestamp: '2026-08-21T19:16:57.892Z', sessionId: 'snd', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'i', name: 'mcp__ccd_session_mgmt__send_message', input: { session_id: 'local_0000', message: 'take option 2, because the migration already exists' } }] } }), 'utf8');
            const { steers, sends } = await scanCorpus({ root: dir });
            joinSteers(steers, sends, new Map());
            return steers.length === 1 && steers[0].join === 'body-hash'
                && steers[0].sentAt === '2026-08-21T19:16:57.892Z' && steers[0].queueMs > 0;
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
        }
    });

    check('an unjoinable steer reports not-measured rather than IN-TIME', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steer-nojoin-'));
        try {
            fs.writeFileSync(path.join(dir, 'r.jsonl'), JSON.stringify(KNOWN_POSITIVE), 'utf8');
            const { steers, sends } = await scanCorpus({ root: dir });
            joinSteers(steers, sends, new Map());
            await measureLatency(steers);
            return steers.length === 1 && steers[0].join === 'none' && steers[0].latency === 'not-measured';
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
        }
    });

    check('a missing file is counted as unreadable, not as an empty one', async () => {
        const r = await scanFile(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now() + '.jsonl'));
        return r.ok === false && r.steers.length === 0;
    });

    // --- run ------------------------------------------------------------------
    const results = [];
    for (const { name, fn } of queue) {
        let ok = false, err = null;
        try { ok = (await fn()) === true; } catch (e) { err = String((e && e.message) || e); }
        results.push({ name, ok, err });
    }
    return results;
}

async function runSelftest() {
    const results = await selftest();
    const failed = results.filter((r) => !r.ok).length;
    console.log('steer-log --selftest');
    console.log('  ' + results.length + ' assertions');
    console.log('');
    for (const r of results) {
        console.log('  ' + (r.ok ? 'ok  ' : 'FAIL') + '  ' + r.name + (r.err ? '   [' + r.err + ']' : ''));
    }
    console.log('');
    console.log('  ' + (results.length - failed) + ' passed, ' + failed + ' failed');
    console.log('  ' + (failed ? 'SELFTEST RED' : 'SELFTEST GREEN'));
    return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------

async function main() {
    const argv = process.argv.slice(2);
    const has = (f) => argv.includes(f);
    const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

    if (has('--selftest')) {
        process.exitCode = await runSelftest();
        return;
    }
    const opts = {
        days: Number(val('--days', 0)) || 0,
        json: has('--json'),
        evidence: has('--evidence'),
        root: val('--root', null),
    };
    process.exitCode = await report(opts);
}

if (require.main === module) {
    main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
}

module.exports = {
    detectDeliveredSteer, detectSends, detectSendResult, isSubstantive,
    scanFile, scanCorpus, joinSteers, measureLatency, controlFires, KNOWN_POSITIVE,
};
