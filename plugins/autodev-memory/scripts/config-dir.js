'use strict';
/**
 * The active Claude profile's config dir, for autodev-memory.
 *
 * A COPY of configDir() and homeDir() in
 * plugins/autodev-core/scripts/claude-paths.js, which carries the reasoning.
 * It is a copy and not a require because CLAUDE_PLUGIN_ROOT resolves per
 * plugin: an installed autodev-memory has no path to autodev-core's files.
 * tooling/test-config-dir-isolation.js asks both the same questions and fails
 * when their answers differ, so change them together.
 */
const os = require('os');
const path = require('path');

function homeDir(env = process.env) {
    return env.USERPROFILE || env.HOME || os.homedir();
}

/** CLAUDE_CONFIG_DIR when set and non-empty, else `<home>/.claude`. */
function configDir(env = process.env) {
    const v = env.CLAUDE_CONFIG_DIR;
    return v ? v : path.join(homeDir(env), '.claude');
}

module.exports = { homeDir, configDir };
