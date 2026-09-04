// redact.mjs — credential-shaped text out, placeholders in. Pure: no `$`, no I/O.
//
// Two jobs share one pattern table.
//
//   redactText(text, vault)   pattern-based: every credential-shaped string
//                             becomes [REDACTED:<kind>#<n>], n stable per
//                             distinct value while the vault lives.
//   Vault                     worker-memory map of value <-> placeholder, so a
//                             key the operator pasted can be put back into a
//                             Bash command (restore) and taken back out of that
//                             command's output (scrub) without ever entering
//                             the transcript.
//
// The vault is NEVER persisted. `$.store` is a JSON file on disk, which is a
// worse home for a secret than the transcript this file exists to protect. A
// hot reload of the plugin empties it; the model then meets a placeholder it
// cannot resolve, the Bash call runs with the placeholder literally, and the
// error names it. That is the safe direction.
//
// The pattern list is the one the transcript scanner converged on after its
// first version reported 1,163 secrets of which 11 were real: every pattern
// has a left anchor, and the generic KEY=value shape is gated on the NAME, not
// on entropy. Entropy is not used at all: a 40-hex git SHA has more of it than
// most API keys, and redacting SHAs would break every git session.

const PLACEHOLDER_RE = /\[REDACTED:([a-z0-9-]+)#(\d+)\]/g;

// A value that is obviously not a live credential: an env reference, a
// template slot, a mask, an example. The KEY=value pattern skips these so an
// `.env.example` or a docs page does not light up.
const NOT_A_SECRET_RE = /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%|<[^>]*>|\[REDACTED|x{4,}$|X{4,}$|\*{3,}|\.{3,}|\(.*\)|your[-_]|example|changeme|placeholder|redacted|null$|undefined$|true$|false$)/;

function decodeJwtPayload(token) {
    try {
        const mid = token.split('.')[1];
        const b64 = mid.replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
        return JSON.parse(bin);
    } catch {
        return null;
    }
}

const JWT_SHAPE_RE = /^eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}$/;

/** A JWT whose payload says `role: anon`: a Supabase publishable key, an
 *  identifier rather than a secret, and the noisiest false positive the
 *  transcript scanner ever produced. */
function isAnonJwt(value) {
    if (!JWT_SHAPE_RE.test(value)) return false;
    const payload = decodeJwtPayload(value);
    return !!payload && payload.role === 'anon';
}

/** A value the named patterns leave alone: an env reference, a template slot,
 *  a mask, an example, or a key that is public by design. */
function isPlaceholderValue(value) {
    return NOT_A_SECRET_RE.test(value) || isAnonJwt(value);
}

/**
 * Each entry: `name`, `re` (global), optional `group` (which capture is the
 * secret; the rest of the match is kept), optional `keep(secret)` returning
 * true to leave a match alone, and `sample()` producing a synthetic
 * known-positive for the suite. Samples are built at run time from a prefix
 * and a repeated letter so no realistic-looking credential ever sits in
 * source, where a later scanner would report it.
 */
export const PATTERNS = [
    {
        name: 'google-refresh-token',
        re: /(?<![A-Za-z0-9+/=_-])1\/\/[A-Za-z0-9_-]{60,}/g,
        sample: () => '1//' + 'A'.repeat(100),
    },
    {
        name: 'google-api-key',
        re: /(?<![A-Za-z0-9+/=_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
        sample: () => 'AIza' + 'B'.repeat(35),
    },
    {
        name: 'anthropic-key',
        re: /sk-ant-[A-Za-z0-9_-]{30,}/g,
        sample: () => 'sk-ant-' + 'C'.repeat(40),
    },
    {
        name: 'openai-key',
        re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g,
        sample: () => 'sk-' + 'D'.repeat(40),
    },
    {
        name: 'github-token',
        re: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}/g,
        sample: () => 'ghp_' + 'E'.repeat(36),
    },
    {
        name: 'github-fine-grained',
        re: /github_pat_[A-Za-z0-9_]{50,}/g,
        sample: () => 'github_pat_' + 'F'.repeat(60),
    },
    {
        name: 'stripe-live-key',
        re: /\b[rs]k_live_[A-Za-z0-9]{20,}/g,
        sample: () => 'sk_live_' + 'G'.repeat(25),
    },
    {
        name: 'slack-token',
        re: /\bxox[baprs]-[A-Za-z0-9-]{20,}/g,
        sample: () => 'xoxb-' + 'H'.repeat(25),
    },
    {
        name: 'slack-app-token',
        re: /\bxapp-[0-9]-[A-Za-z0-9-]{20,}/g,
        sample: () => 'xapp-1-' + 'I'.repeat(25),
    },
    {
        name: 'aws-access-key',
        re: /\bAKIA[0-9A-Z]{16}\b/g,
        sample: () => 'AKIA' + 'JKLMNOPQRSTUVWXY',
    },
    {
        name: 'doppler-token',
        re: /\bdp\.(?:st|pt|sa|ct|it|scim)\.[A-Za-z0-9]{40,}/g,
        sample: () => 'dp.st.' + 'K'.repeat(43),
    },
    {
        // A JWT whose payload says `role: anon` is a Supabase publishable key:
        // an identifier, public by design, and the noisiest false positive the
        // transcript scanner ever produced. Anything else (service_role, a
        // session token, an undecodable middle segment) is treated as live.
        name: 'jwt',
        re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g,
        keep: isAnonJwt,
        sample: () => {
            const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
            return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ role: 'service_role', iss: 'supabase' }) + '.' + 'L'.repeat(43);
        },
    },
    {
        name: 'private-key-block',
        re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----|$)/g,
        sample: () => '-----BEGIN PRIVATE KEY-----\n' + 'M'.repeat(64) + '\n-----END PRIVATE KEY-----',
    },
    {
        // postgres://user:PASSWORD@host — only the password is replaced, so
        // the host and database name a session needs stay readable.
        name: 'url-password',
        re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{4,})(@)/gi,
        group: 2,
        sample: () => 'postgresql://app:' + 'N'.repeat(24) + '@db.example.internal:5432/app',
    },
    {
        name: 'bearer-token',
        re: /\b(Authorization\s*[:=]\s*["']?Bearer\s+)([A-Za-z0-9._~+/=-]{20,})/gi,
        group: 2,
        sample: () => 'Authorization: Bearer ' + 'O'.repeat(32),
    },
    {
        // NAME=value and NAME: value where NAME says it is a secret. This is
        // the shape of every env file, and the shape a masking sed missed on
        // 2026-08-31 because two files spelled the separator with spaces.
        name: 'named-assignment',
        re: /^(\s*(?:export\s+|set\s+|\$env:)?[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?)[A-Za-z0-9_]*\s*[=:]\s*["']?)([^\s"']{12,})/gim,
        group: 2,
        keep: (value) => isPlaceholderValue(value),
        sample: () => 'SUPABASE_SERVICE_ROLE_KEY=' + 'P'.repeat(32),
    },
    {
        // A table row as `doppler secrets` and `doppler secrets delete` print
        // one: `│ NAME │ value │`. The 2026-09-02 leak was exactly this shape.
        name: 'named-table-row',
        re: /^(\s*[│|]?\s*[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?)[A-Za-z0-9_]*\s*[│|]\s*)([^\s│|]{8,})/gim,
        group: 2,
        keep: (value) => isPlaceholderValue(value),
        sample: () => '│ QA_PRO_PASSWORD │ ' + 'Q'.repeat(16) + ' │',
    },
];

/**
 * Worker-memory map between secret values and their placeholders.
 * Bounded: past MAX_ENTRIES the oldest entry is dropped, so a session that
 * pastes hundreds of distinct values cannot grow the worker without limit.
 */
export class Vault {
    constructor(maxEntries = 256) {
        this.maxEntries = maxEntries;
        this.byValue = new Map();       // value -> placeholder
        this.byPlaceholder = new Map(); // placeholder -> value
        this.counter = 0;
    }

    get size() {
        return this.byValue.size;
    }

    placeholderFor(kind, value) {
        const known = this.byValue.get(value);
        if (known) return known;
        this.counter += 1;
        const placeholder = `[REDACTED:${kind}#${this.counter}]`;
        this.byValue.set(value, placeholder);
        this.byPlaceholder.set(placeholder, value);
        if (this.byValue.size > this.maxEntries) {
            const oldestValue = this.byValue.keys().next().value;
            const oldestPlaceholder = this.byValue.get(oldestValue);
            this.byValue.delete(oldestValue);
            this.byPlaceholder.delete(oldestPlaceholder);
        }
        return placeholder;
    }

    /** Placeholders in `text` become their values again. */
    restore(text) {
        let restored = 0;
        const out = String(text).replace(PLACEHOLDER_RE, (whole) => {
            const value = this.byPlaceholder.get(whole);
            if (value === undefined) return whole;
            restored += 1;
            return value;
        });
        return { text: out, restored };
    }

    /** Known values in `text` become their placeholders. Longest value first,
     *  so a value that contains another is replaced whole. */
    scrub(text) {
        let scrubbed = 0;
        let out = String(text);
        if (this.byValue.size === 0 || out.length === 0) return { text: out, scrubbed };
        const values = [...this.byValue.keys()].sort((a, b) => b.length - a.length);
        for (const value of values) {
            if (!out.includes(value)) continue;
            const placeholder = this.byValue.get(value);
            out = out.split(value).join(placeholder);
            scrubbed += 1;
        }
        return { text: out, scrubbed };
    }
}

/**
 * Pattern-based redaction. Returns `{ text, count, kinds }`; `kinds` is a
 * name -> count map so a log line can say WHAT was redacted without saying
 * what it was. With a vault, placeholders are stable per value and the value
 * is remembered for restore/scrub; without one, placeholders are numbered per
 * call and nothing is remembered.
 */
export function redactText(text, vault) {
    let out = String(text);
    if (out.length === 0) return { text: out, count: 0, kinds: {} };
    const kinds = {};
    let count = 0;
    let local = 0;
    for (const pattern of PATTERNS) {
        pattern.re.lastIndex = 0;
        out = out.replace(pattern.re, (...args) => {
            const whole = args[0];
            const groups = args.slice(1, -2);
            const secret = pattern.group ? groups[pattern.group - 1] : whole;
            if (!secret) return whole;
            if (pattern.keep && pattern.keep(secret)) return whole;
            count += 1;
            kinds[pattern.name] = (kinds[pattern.name] || 0) + 1;
            const placeholder = vault
                ? vault.placeholderFor(pattern.name, secret)
                : `[REDACTED:${pattern.name}#${++local}]`;
            if (!pattern.group) return placeholder;
            // Rebuild the match with only the secret group replaced.
            const start = whole.indexOf(secret);
            return whole.slice(0, start) + placeholder + whole.slice(start + secret.length);
        });
    }
    return { text: out, count, kinds };
}

/** Pattern redaction plus exact scrub of every value the vault knows. */
export function scrubText(text, vault) {
    const known = vault ? vault.scrub(text) : { text: String(text), scrubbed: 0 };
    const patterned = redactText(known.text, vault);
    return {
        text: patterned.text,
        count: known.scrubbed + patterned.count,
        kinds: patterned.kinds,
    };
}

export function describeKinds(kinds) {
    return Object.entries(kinds).map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(', ');
}
