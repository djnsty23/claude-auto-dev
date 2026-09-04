// autodev-fn.mjs — autodev-core's hooks module (Claude Code "function hooks").
//
// EARLY ACCESS SURFACE. Loads only where the host has enabled hooks modules
// (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, or the rollout flag); everywhere
// else the `modules` entry in hooks.json is skipped and every shell hook
// beside it runs unchanged. The declarations this is written against are
// produced by `/plugin-types` in a session, or by tooling/extract-plugin-types.js.
//
// Four things a shell hook structurally cannot do, in one module because the
// loader takes one module per plugin:
//
//   1. prompt.submit        a pasted credential becomes [REDACTED:kind#n]
//                           before the model sees it: the user message row
//                           and every tool row carry the placeholder. (The
//                           harness's own queue-operation row is written
//                           earlier and can still hold the typed text; the
//                           SessionEnd scan covers that.) The value lives in
//                           worker memory, never $.store, so a Bash command
//                           that names the placeholder still runs with it.
//   2. tool.call {Bash}     the command is decided (bash-rules.mjs: three
//                           denies scoped to this repo, two rewrites anywhere)
//                           and its stdout/stderr are scrubbed of known values
//                           and credential-shaped text before the model or
//                           the transcript sees them.
//   3. attribution.text     the commit trailer is empty text. The standing
//                           rule here is no co-author trailer, and a
//                           mid-session instruction keeps re-adding one.
//   4. $.ui.status          one pinned line under the prompt: what this
//                           module did this session, and the sprint's five
//                           state counts from prd.json, at no context cost.
//
// THE SCANNER'S RULE, which shapes every line below: `$` is only ever spelled
// `$.noun.event(...)` at a call site. It is never passed to a helper, bound,
// or read, so the helpers in this directory are pure and every `$` call is
// inline. `claude plugin validate <plugin-dir>` lists what this file hooks and
// calls; an op it did not list is refused at run time.
//
// A hook that throws is skipped and `next`'s result stands, so a defect here
// degrades to "no redaction on this call", never to a broken tool. The cost
// of that is silence, which is why the status line exists: its absence is the
// tell that the module is not running.

import { redactText, scrubText, describeKinds, Vault } from './redact.mjs';
import { decideBash } from './bash-rules.mjs';
import { storiesOf, summarise, formatStatus } from './sprint-status.mjs';

const vault = new Vault();
const tally = { redacted: 0, denied: 0, rewritten: 0 };

/** Whether `text` mentions a placeholder at all: the cheap pre-check before
 *  a restore, so an ordinary command costs one indexOf. */
const mentionsPlaceholder = (text) => String(text).includes('[REDACTED:');

/** @type {import('claude-code').Register} */
export function register(on) {
    on('session.start', async ($, e, next) => {
        let counts = null;
        try {
            if (await $.fs.exists('prd.json')) {
                counts = summarise(storiesOf(JSON.parse(await $.fs.readFile('prd.json'))));
            }
        } catch {
            counts = null;
        }
        $.ui.status(formatStatus({ counts, tally }));
        return next(e);
    });

    on('prompt.submit', async ($, e, next) => {
        const r = redactText(e.text, vault);
        if (r.count === 0) return next(e);
        tally.redacted += r.count;
        $.ui.log(`autodev-fn: redacted ${r.count} pasted secret(s) (${describeKinds(r.kinds)}); the value is held in memory for this session and put back when a Bash command names the placeholder`);
        return next({ ...e, text: r.text });
    });

    on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
        const typed = String(e.command ?? '');

        // 1. A placeholder in the command is the model using a pasted secret.
        let command = typed;
        if (mentionsPlaceholder(typed)) {
            const restored = vault.restore(typed);
            command = restored.text;
        }

        // 2. The rules. The repo is read once per call: it is one host round
        //    trip, and the session can `cd` between calls.
        let decision;
        try {
            decision = decideBash({ command, cwd: await $.session.cwd(), repo: await $.session.repo() });
        } catch {
            decision = { command, notes: [], rules: [] };
        }
        if (decision.deny) {
            tally.denied += 1;
            $.ui.log(`autodev-fn: denied a Bash call (${decision.rule})`);
            return { deny: `autodev-fn (${decision.rule}): ${decision.deny}` };
        }
        if (decision.rules.length) {
            tally.rewritten += decision.rules.length;
            $.ui.log(`autodev-fn: rewrote a Bash call (${decision.rules.join(', ')})`);
        }

        const input = decision.command === typed ? e : { ...e, command: decision.command };
        const out = await next(input);
        if (!out || out.deny || out.result === null || typeof out.result !== 'object') return out;

        // 3. Scrub the output: exact values the vault knows, then patterns.
        const result = out.result;
        let changed = false;
        let count = 0;
        const kinds = {};
        const scrubbed = { ...result };
        for (const key of ['stdout', 'stderr']) {
            if (typeof result[key] !== 'string' || result[key].length === 0) continue;
            const s = scrubText(result[key], vault);
            if (s.count === 0) continue;
            scrubbed[key] = s.text;
            changed = true;
            count += s.count;
            for (const [k, n] of Object.entries(s.kinds)) kinds[k] = (kinds[k] || 0) + n;
        }

        const notes = decision.notes.map((n) => `autodev-fn ${n}`);
        if (changed) {
            tally.redacted += count;
            $.ui.log(`autodev-fn: redacted ${count} secret(s) from Bash output${Object.keys(kinds).length ? ` (${describeKinds(kinds)})` : ''}`);
            notes.push(`autodev-fn redacted ${count} credential-shaped value(s) from this output; a [REDACTED:kind#n] token can be passed back into a later Bash command verbatim.`);
        }
        if (!changed && notes.length === 0) return out;

        const context = [...(out.context ?? []), ...notes];
        // A rewritten result cannot carry core's `ref`: core renders it with the
        // tool's own mapper from `result` alone. An untouched result keeps the
        // object it got, so core uses its own messages verbatim.
        return changed ? { result: scrubbed, context } : { ...out, context };
    });

    on('attribution.text', { kind: 'commit' }, () => ({ text: '' }));

    on('turn.complete', async ($, e, next) => {
        let counts = null;
        try {
            if (await $.fs.exists('prd.json')) {
                counts = summarise(storiesOf(JSON.parse(await $.fs.readFile('prd.json'))));
            }
        } catch {
            counts = null;
        }
        $.ui.status(formatStatus({ counts, tally }));
        return next(e);
    });
}
