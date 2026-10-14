'use strict';
/**
 * worker-profiles.js - the explicit tool set each kind of headless claude run
 * starts with. A library; it prints nothing.
 *
 * WHY. headless-worker.js used to start every worker with the CLI's whole
 * default tool set minus a literal list (`--disallowedTools Artifact,...`). Any
 * tool a CLI release added arrived in every worker unasked, and the boot surface
 * grew with it. `[measured 2026-10-13]` on a 71.2k turn 1, the three Artifact
 * tools cost 11.4k tokens and Workflow 2.0k. A profile names what a kind gets,
 * and the CLI's `--tools <list>` (claude 2.1.299 --help: "Specify the list of
 * available tools from the built-in set") gives it exactly that.
 *
 * A PROFILE has
 *   tools     built-in tools loaded at boot
 *   deferred  built-in tools the run may find through ToolSearch, never at boot.
 *             They go in --tools too: --tools bounds the set, and the CLI defers.
 *   required  the tools the kind's task cannot do without. A profile whose
 *             tools and deferred lack one is a broken profile.
 * Families add to a profile when the prompt names them or --keep-tools keeps
 * them, so a brief that uses an artifact or a Workflow still gets it.
 *
 * WHAT THIS DOES NOT PROVE. The suite drives a stub CLI that implements --tools
 * as documented. Whether ToolSearch inside --tools defers the listed tools on
 * the real CLI is unverified here: check one real init message by hand after a
 * CLI upgrade (`claude -p --tools <list> --output-format stream-json --verbose`).
 */

const PROFILES = Object.freeze({
    // A headless builder: reads, edits and runs the repo's gate, delegates to agents and skills.
    builder: Object.freeze({
        tools: Object.freeze(['Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Skill', 'TodoWrite', 'ToolSearch', 'Write']),
        deferred: Object.freeze(['WebFetch', 'WebSearch']),
        required: Object.freeze(['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'ToolSearch']),
    }),
    // brain-judge: the report and brief travel in the prompt, so the judge needs no tool.
    judge: Object.freeze({ tools: Object.freeze([]), deferred: Object.freeze([]), required: Object.freeze([]) }),
    // brain-judge probe: one tool-less reply that proves the login works.
    probe: Object.freeze({ tools: Object.freeze([]), deferred: Object.freeze([]), required: Object.freeze([]) }),
});

/** Heavy families a builder starts without unless its prompt names them or --keep-tools keeps them. */
const FAMILIES = Object.freeze({
    Artifact: Object.freeze({ tools: Object.freeze(['Artifact', 'ArtifactComments', 'ArtifactData']), named: /\bArtifact(?:Data|Comments)?\b|claude\.ai\/(?:code\/)?artifact\//i }),
    Workflow: Object.freeze({ tools: Object.freeze(['Workflow']), named: /\bWorkflow\b|\bultracode\b/ }),
});

const KINDS = Object.keys(PROFILES);

function fault(code, message) { const e = new Error(message); e.publicCode = code; throw e; }

function requireKind(kind) {
    if (!KINDS.includes(kind)) fault('usage', `--profile must be one of ${KINDS.join(', ')}; got ${kind}`);
    return kind;
}

/** The families a text names. */
function namedFamilies(text) {
    return Object.entries(FAMILIES).filter(([, f]) => f.named.test(String(text || ''))).map(([name]) => name);
}

/**
 * The resolved tool set for one run: { kind, families, tools, deferred, required, allowed, flag }.
 * `allowed` is everything the run may ever see. `flag` is the --tools value ('' for none).
 */
function resolve(kind, { prompt = '', keep = [] } = {}) {
    const p = PROFILES[requireKind(kind)];
    const families = kind === 'builder' ? [...new Set([...keep, ...namedFamilies(prompt)])].filter((f) => FAMILIES[f]).sort() : [];
    const tools = [...p.tools, ...families.flatMap((f) => FAMILIES[f].tools)];
    const allowed = [...new Set([...tools, ...p.deferred])].sort();
    return { kind, families, tools, deferred: [...p.deferred], required: [...p.required], allowed, flag: allowed.join(',') };
}

/** The argv tail that applies a resolved profile: always exactly one --tools. */
function toolsArgs(resolved) { return ['--tools', resolved.flag]; }

/**
 * The tool manifest a run actually started with, read from its own output: the
 * stream-json `system`/`init` event. { found, tools, deferred, all } or found false.
 */
function initManifest(text) {
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line.startsWith('{') || !line.includes('"subtype":"init"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (!j || j.type !== 'system' || j.subtype !== 'init' || !Array.isArray(j.tools)) continue;
        const deferred = Array.isArray(j.deferred_tools) ? j.deferred_tools : [];
        return { found: true, tools: j.tools.slice(), deferred: deferred.slice(), all: [...new Set([...j.tools, ...deferred])].sort() };
    }
    return { found: false, tools: [], deferred: [], all: [] };
}

/** Grade a manifest against a resolved profile: { missingRequired, hidden, exact }. */
function grade(manifest, resolved) {
    const have = new Set(manifest.all);
    const allowed = new Set(resolved.allowed);
    const missingRequired = resolved.required.filter((t) => !have.has(t));
    const hidden = manifest.all.filter((t) => !allowed.has(t));
    const exact = hidden.length === 0 && resolved.allowed.every((t) => have.has(t));
    return { missingRequired, hidden, exact };
}

module.exports = { PROFILES, FAMILIES, KINDS, requireKind, namedFamilies, resolve, toolsArgs, initManifest, grade };
