'use strict';
// Case worker-report-outbox: a headless worker is told to write its report
// where its permission mode refuses every write.
//
// The failure (usage-mine class permission-denied/mode:dontAsk, target
// config-dir): the launcher composed a prompt naming the ledger REPORT.md under
// the config dir. dontAsk refuses Write and Bash writes there, so the worker
// had nowhere to report.
//
// PASS: the prompt names at least one REPORT.md (floor), and none of the report
// or ask.json paths it names sits under the config dir.
const path = require('path');
const { withWorkerPrompt } = require('./lib/worker-prompt.js');

function check({ repo }) {
    return withWorkerPrompt(repo, ({ prompt, home }) => {
        const cfg = path.join(home, '.claude').replace(/\\/g, '/').toLowerCase();
        const named = [...prompt.matchAll(/([A-Za-z]:[\\/][^\s`"']+|\/[^\s`"']+)/g)].map((m) => m[1].replace(/\\/g, '/').replace(/[.,;:)]+$/, ''))
            .filter((p) => /(?:REPORT\.md|ask\.json)$/i.test(p));
        const reports = named.filter((p) => /REPORT\.md$/i.test(p));
        const inConfig = [...new Set(named.filter((p) => p.toLowerCase().startsWith(cfg + '/')))];
        if (!reports.length) return { pass: false, detail: 'the prompt names no REPORT.md at all: the worker has no return channel' };
        return inConfig.length
            ? { pass: false, detail: `the prompt tells the worker to write ${inConfig.length} path(s) under the config dir, which dontAsk refuses: ${inConfig.map((p) => p.slice(cfg.length)).join(', ')}` }
            : { pass: true, detail: `${reports.length} REPORT.md path(s) named, none under the config dir` };
    });
}

module.exports = { check };
