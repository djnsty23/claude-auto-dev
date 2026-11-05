'use strict';
// Case worker-prompt-authority: the worker prompt invites an action the
// worker's own guard refuses.
//
// The failure (usage-mine class hook-block/worker-authority, 101 sessions since
// 2026-10-08): worker-authority.js denies a builder `git push`, PR writes and
// worktree-config changes, and the largest refusal shapes were exactly those.
// The prompt composed by unattended-worker.js said "Before any commit, push or
// merge, ...", which reads as permission to push.
//
// The privileged verbs are a hand-written list, not read from worker-authority.js,
// so weakening the guard cannot shrink this check with it.
//
// PASS: no sentence of the prompt names a privileged action without also saying
// the worker must not do it.
const { withWorkerPrompt } = require('./lib/worker-prompt.js');

const PRIVILEGED = [
    ['git push', /\bpush(?:es|ed|ing)?\b/i],
    ['gh pr create or merge', /\bgh pr (?:create|merge)\b|\bopen (?:a|the) PR\b/i],
    ['git worktree config', /extensions\.worktreeConfig|git config --worktree/i],
];
const NEGATED = /\b(?:not|never|no|cannot|can't|don't|belongs? to|stays? with|leave)\b/i;

function check({ repo }) {
    return withWorkerPrompt(repo, ({ prompt }) => {
        const sentences = prompt.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
        if (sentences.length < 5) return { pass: false, indeterminate: true, detail: `the prompt has ${sentences.length} sentences: too few to be the real prompt` };
        const invites = [];
        for (const s of sentences) for (const [name, re] of PRIVILEGED) if (re.test(s) && !NEGATED.test(s)) invites.push(`${name}: "${s.slice(0, 90)}"`);
        return invites.length
            ? { pass: false, detail: `${invites.length} sentence(s) invite what worker-authority refuses: ${invites.join(' | ')}` }
            : { pass: true, detail: `${sentences.length} sentences, none invites a privileged action` };
    });
}

module.exports = { check, PRIVILEGED, NEGATED };
