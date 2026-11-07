#!/usr/bin/env node
/**
 * paid-key-guard.js - refuse to launch a model process that would bill a paid
 * API key when the plan is a subscription login.
 *
 * WHY. A headless worker, a judge or a cheap reviewer is meant to run on a
 * subscription login. An API key in the environment silently switches the CLI
 * to per-token billing, and an unattended loop can spend real money before
 * anyone looks. The key usually arrives by accident: a shell profile, a
 * dotenv loader, a provider key passed through for one run and never removed.
 * So every launch path checks the environment its child would receive and
 * refuses when a paid key is in it. The refusal names the variable, never its
 * value.
 *
 * Library:
 *   const guard = require('./paid-key-guard');
 *   guard.paidKeysIn(env)                      names present, from PAID_KEYS plus AUTODEV_PAID_KEY_NAMES
 *   guard.assertSubscriptionEnv(env, {allow})  throws (publicCode 'paid-key-refused') unless allowed
 *   guard.stripPaidKeys(env)                   a copy of env without the paid names
 *   guard.allowedByEnv(env)                    true when AUTODEV_ALLOW_PAID_KEY is exactly "1"
 *
 * A name counts as present when its value is a non-empty string other than
 * "0". Names compare case-insensitively, because Windows environments do
 * not distinguish case and a copied env object does not either way.
 *
 * Allowing. `allow` is true (every paid name), or an array of names that are
 * allowed (the others still refuse). Callers pass `allowedByEnv(process.env)`
 * as the operator's explicit opt-in: AUTODEV_ALLOW_PAID_KEY=1.
 *
 * CLI (for a shell wrapper or a brief):
 *   node paid-key-guard.js check      exit 0 when the environment holds no paid
 *                                     key or AUTODEV_ALLOW_PAID_KEY=1, exit 1 and
 *                                     name the variables otherwise
 *   node paid-key-guard.js --help
 *
 * ENVIRONMENT.
 *   AUTODEV_PAID_KEY_NAMES=A,B     extra names to treat as paid keys
 *   AUTODEV_ALLOW_PAID_KEY=1       the explicit opt-in that lets a launch carry a paid key
 */
'use strict';

const PAID_KEYS = Object.freeze([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_BEARER_TOKEN_BEDROCK',
]);

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isSet(v) { return typeof v === 'string' && v.trim() !== '' && v.trim() !== '0'; }

/** The extra names an env lists in AUTODEV_PAID_KEY_NAMES; anything not shaped like a variable name is ignored. */
function extraNames(env) {
    const raw = env && typeof env.AUTODEV_PAID_KEY_NAMES === 'string' ? env.AUTODEV_PAID_KEY_NAMES : '';
    return raw.split(',').map((s) => s.trim()).filter((s) => NAME_RE.test(s));
}

/** Every name treated as a paid key for this env: the exported list plus the extension, from the env checked and from this process. */
function paidNames(env) {
    const out = new Map();
    for (const n of [...PAID_KEYS, ...extraNames(env), ...extraNames(process.env)]) out.set(n.toUpperCase(), n);
    return [...out.values()];
}

/** The paid-key names present in env, as the env spells them. Values are never returned. */
function paidKeysIn(env) {
    const want = new Set(paidNames(env).map((n) => n.toUpperCase()));
    const found = [];
    for (const [k, v] of Object.entries(env || {})) {
        if (want.has(k.toUpperCase()) && isSet(v)) found.push(k);
    }
    return found.sort();
}

/** True only when AUTODEV_ALLOW_PAID_KEY is exactly "1": the operator's explicit opt-in. */
function allowedByEnv(env) { return Boolean(env) && env.AUTODEV_ALLOW_PAID_KEY === '1'; }

function fault(code, message) { const e = new Error(message); e.publicCode = code; return e; }

/**
 * Throws when env holds a paid key that is not allowed. `allow`: true allows
 * every name, an array allows only the names it lists. The message names the
 * variables and how to opt in; it never carries a value.
 */
function assertSubscriptionEnv(env, { allow = false } = {}) {
    const found = paidKeysIn(env);
    if (!found.length || allow === true) return { allowed: found };
    const okNames = new Set((Array.isArray(allow) ? allow : []).map((n) => String(n).toUpperCase()));
    const blocked = found.filter((n) => !okNames.has(n.toUpperCase()));
    if (!blocked.length) return { allowed: found };
    throw fault('paid-key-refused', `refusing to launch: ${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} set, which would bill a paid key instead of the subscription login. `
        + 'Unset it, or set AUTODEV_ALLOW_PAID_KEY=1 to allow it on purpose');
}

/** A copy of env without the paid-key names. */
function stripPaidKeys(env) {
    const drop = new Set(paidKeysIn(env).map((n) => n.toUpperCase()));
    const out = {};
    for (const [k, v] of Object.entries(env || {})) if (!drop.has(k.toUpperCase())) out[k] = v;
    return out;
}

module.exports = { PAID_KEYS, paidKeysIn, paidNames, assertSubscriptionEnv, stripPaidKeys, allowedByEnv };

function main(argv) {
    const cmd = argv[0];
    if (!cmd || cmd === '--help' || cmd === '-h') {
        process.stdout.write('usage: node paid-key-guard.js check\n'
            + 'Exit 0 when the environment holds no paid API key (or AUTODEV_ALLOW_PAID_KEY=1), exit 1 naming the variables otherwise.\n'
            + `Paid names: ${PAID_KEYS.join(', ')}, plus those in AUTODEV_PAID_KEY_NAMES. Values are never printed.\n`);
        return;
    }
    if (cmd !== 'check') {
        process.stderr.write(`paid-key-guard: unknown command ${cmd}; see --help\n`);
        process.exitCode = 2;
        return;
    }
    try {
        const r = assertSubscriptionEnv(process.env, { allow: allowedByEnv(process.env) });
        process.stdout.write(r.allowed.length ? `paid-key-guard: ${r.allowed.join(', ')} present and allowed by AUTODEV_ALLOW_PAID_KEY=1\n` : 'paid-key-guard: no paid key in the environment\n');
    } catch (e) {
        process.stderr.write(`paid-key-guard: ${e.message}\n`);
        process.exitCode = 1;
    }
}

if (require.main === module) main(process.argv.slice(2));
