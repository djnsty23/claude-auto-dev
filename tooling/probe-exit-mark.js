'use strict';
// Preloaded into a scorecard probe (NODE_OPTIONS --require) to tell a probe that
// failed from a probe that was killed.
//
// A node process that ends normally, by an exit code or a thrown error, runs its
// 'exit' event. One terminated from outside (TerminateProcess, SIGKILL) does not.
// On 14 Oct a probe ended with status 1, no output and no exit event while other
// sessions were running, and the scorecard recorded it as a failed check.
//
// The first node process to load this file claims the marker: it writes "start"
// now and "exit <code>" from its exit event. It removes the variable from its own
// environment, so the node processes it spawns do not overwrite the marker.

const fs = require('fs');

const mark = process.env.AUTODEV_PROBE_EXIT_MARK;
if (mark) {
    delete process.env.AUTODEV_PROBE_EXIT_MARK;
    try {
        fs.writeFileSync(mark, `start ${process.pid}\n`);
        process.on('exit', (code) => {
            try { fs.appendFileSync(mark, `exit ${code}\n`); } catch { /* the marker dir went away */ }
        });
    } catch { /* no marker: the probe reads as an ordinary run */ }
}
