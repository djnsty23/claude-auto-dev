#!/usr/bin/env node
// cpu-preload.js - records this process's own CPU time when it exits.
//
// Loaded with `--require` through NODE_OPTIONS by tooling/cpu-telemetry.js, never
// by a plugin. When AUTODEV_CPU_TELEMETRY_DIR names a directory, the process
// writes one JSON record there on exit: its pid, its parent pid and
// process.cpuUsage() (user and system microseconds since the process started,
// every thread). Without the variable it does nothing at all.
//
// WHY INSIDE THE SUBJECT. A parent that times spawnSync measures itself waiting,
// and its own CPU through a blocking spawn is close to zero whatever the child
// did. Only the process that did the work can report the work. NODE_OPTIONS is
// inherited, so a Node descendant of the subject records itself too.
//
// A process that never reaches 'exit' (killed by a signal, TerminateProcess on
// Windows) writes nothing. The reader treats a missing record as NO MEASUREMENT,
// never as zero CPU.
//
// It prints nothing and never throws: a write it cannot make is lost telemetry,
// not a failure of the process it rides in.
//
//   node tooling/cpu-preload.js --help

'use strict';

const ENV_DIR = 'AUTODEV_CPU_TELEMETRY_DIR';

if (require.main === module) {
    console.log('usage: NODE_OPTIONS="--require <this file>" AUTODEV_CPU_TELEMETRY_DIR=<dir> node <script>\n'
        + 'Writes one CPU record per Node process into <dir> on exit. Loaded by tooling/cpu-telemetry.js.');
} else {
    const dir = process.env[ENV_DIR];
    if (dir) {
        process.on('exit', () => {
            try {
                const fs = require('fs');
                const path = require('path');
                const u = process.cpuUsage();
                const name = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
                fs.writeFileSync(path.join(dir, name), JSON.stringify({
                    pid: process.pid, ppid: process.ppid, user: u.user, system: u.system,
                }));
            } catch { /* lost telemetry is read as no measurement */ }
        });
    }
}
