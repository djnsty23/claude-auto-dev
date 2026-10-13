#!/usr/bin/env node
/**
 * instruction-envelope - SessionStart: say so when the always-on instruction set is
 * over budget, has lost a required rule, or carries conflicting style directives.
 *
 * Nothing to say means ZERO bytes on stdout and stderr, and every path exits 0. The
 * measurement and the blocking preflight live in scripts/instruction-envelope.js. This
 * hook only reports: a session cannot fix its own rules before it starts, so a block
 * here would cost the user a session and fix nothing. The block belongs to the update
 * path (`instruction-envelope.js apply`), which refuses the change before it lands.
 */
'use strict';
// The `instruction_envelope` switch (plugin userConfig) skips this hook: it advises, it never guards.
if (process.env.CLAUDE_PLUGIN_OPTION_INSTRUCTION_ENVELOPE === 'false') process.exit(0);

const path = require('path');

try {
    const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
    const envelope = require(path.join(root, 'scripts', 'instruction-envelope.js'));
    const line = envelope.hookLine(process.env);
    if (line) process.stdout.write(JSON.stringify({ systemMessage: line }) + '\n');
} catch { /* advisory: an unreadable profile is not a reason to speak or to block */ }
process.exitCode = 0;
