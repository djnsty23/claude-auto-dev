#!/usr/bin/env node
// text-hygiene.mjs: clean AI-generated copy before it is published.
//
// Removes the character-level marks that model output and copy-paste carry
// (zero-width characters, bidi controls, Unicode tag characters, stray
// variation selectors, odd spaces), normalises the typographic tells (em
// dashes, the ellipsis character, curly quotes, Romanian cedilla letters) and
// REPORTS stock AI phrases without rewriting them. See text-hygiene.md.
//
// One self-contained file, no dependencies and no static imports, so it can be
// vendored into a web app: the CLI half reaches Node's built-ins only through
// process.getBuiltinModule, and only when the file runs as a CLI.
//
//   node text-hygiene.mjs [--locale en|ro] [--dashes comma|hyphen|keep] [--check] [--json] <file|->
//
// What it cannot do: statistical watermarks live in word choice, not in
// characters. No character filter touches them.

/** Stock phrases that read as machine-written. Extend it: `AI_PHRASES.push('...')`.
 *  Matching ignores case, accepts ' or U+2019 for an apostrophe, any whitespace
 *  run for a space, and Romanian letters with or without diacritics. A trailing
 *  * matches any word ending ("delv*" finds delve, delves, delving). A RegExp
 *  entry is used as given (the g flag is added). */
export const AI_PHRASES = [
    // English
    'delv*',
    "in today's fast-paced world",
    "in today's digital age",
    "in today's world",
    'ever-evolving landscape',
    'in the ever-evolving',
    "it's worth noting",
    'it is worth noting',
    "it's important to note",
    'it is important to note',
    'unlock the power',
    'unlock the potential',
    'unleash the power',
    'harness the power',
    'a testament to',
    'navigate the complexities',
    'navigating the complexities',
    'rich tapestry',
    'tapestry of',
    'in the realm of',
    'embark on a journey',
    "let's dive in",
    'dive deep into',
    'plays a crucial role',
    'plays a pivotal role',
    'game-changer',
    'elevate your',
    'look no further',
    'in conclusion',
    'I hope this helps',
    'as an AI language model',
    'great question',
    'good question',
    'excellent question',
    // Romanian
    'în lumea de azi',
    'în lumea de astăzi',
    'în era digitală',
    'într-o lume în continuă schimbare',
    'în peisajul actual',
    'este important de menționat',
    'este important să menționăm',
    'merită menționat',
    'merită să menționăm',
    'în concluzie',
    'nu în ultimul rând',
    'descoperă puterea',
    'deblochează potențialul',
    'o mărturie a',
    'joacă un rol crucial',
    'joacă un rol esențial',
    'hai să explorăm',
    'haideți să descoperim',
    'bună întrebare',
    'întrebare excelentă',
    'excelentă întrebare',
];

/** Every key `changes` carries, always present, 0 when nothing of that class was found. */
export const CHANGE_CLASSES = Object.freeze([
    'invisible', 'bidi', 'tags', 'variationSelectors', 'spaces',
    'dashes', 'ellipsis', 'quotes', 'diacritics', 'whitespace',
]);

export const LOCALES = Object.freeze(['en', 'ro']);
export const DASH_MODES = Object.freeze(['comma', 'hyphen', 'keep']);

// --- character tables ------------------------------------------------------

// U+200E, U+200F and U+061C are direction MARKS rather than controls. In en and
// ro copy they are invisible copy-paste residue, so they go with the rest.
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;
const TAG_RUN_RE = /[\u{E0000}-\u{E007F}]+/gu;
// The three RGI subdivision flags are the only legitimate tag sequences.
const FLAG_TAG_RUNS = new Set(['gbeng', 'gbsct', 'gbwls'].map((code) =>
    [...code].map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('') + '\u{E007F}'));
const INVISIBLE_RE = /[\u200B\u200C\u200D\u2060-\u2064\u180E\u00AD\u034F\u115F\u1160\u3164\uFFA0]/g;
const SELECTOR_RUN_RE = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]+/gu;
const ODD_SPACE_RE = /[\u2002-\u200A\u202F\u205F\u3000]/g;
const NBSP_KEEP_AFTER_RE = /^(?:%|\u2030|\u20AC|\$|\u00A3|(?:lei|RON|EUR|USD)(?![\p{L}\p{N}]))/u;
const UNIT_RE = /^(?:\d|(?:kg|mg|g|t|km|cm|mm|m|ml|l|L|h|min|s|ms|px|pt|rem|em|B|kB|KB|MB|GB|TB|W|kW|kWh|MW|V|A|Hz|kHz|MHz|GHz|\u00B0C|\u00B0F|\u00B0)(?![\p{L}\p{N}]))/u;
const COMMA_BELOW = { 'ş': 'ș', 'Ş': 'Ș', 'ţ': 'ț', 'Ţ': 'Ț', s: 'ș', S: 'Ș', t: 'ț', T: 'Ț' };

const isEmoji = (ch) => /\p{Emoji}/u.test(ch);
const isPictographic = (ch) => /\p{Extended_Pictographic}/u.test(ch);
const isLineBreak = (ch) => ch === undefined || ch === '\n' || ch === '\r';

/** The code point that ends just before `off`, surrogate pairs included. */
function codePointBefore(str, off) {
    if (off <= 0) return undefined;
    const lo = str.charCodeAt(off - 1);
    if (lo >= 0xDC00 && lo <= 0xDFFF && off >= 2) {
        const hi = str.charCodeAt(off - 2);
        if (hi >= 0xD800 && hi <= 0xDBFF) return str.slice(off - 2, off);
    }
    return str[off - 1];
}

function codePointAt(str, off) {
    if (off >= str.length) return undefined;
    return String.fromCodePoint(str.codePointAt(off));
}

// --- global passes (every segment, code included) ---------------------------

function stripBidi(s, changes) {
    return s.replace(BIDI_RE, () => { changes.bidi++; return ''; });
}

function stripTags(s, changes, hidden) {
    return s.replace(TAG_RUN_RE, (run, off, whole) => {
        if (codePointBefore(whole, off) === '\u{1F3F4}' && FLAG_TAG_RUNS.has(run)) return run;
        let decoded = '';
        for (const ch of run) {
            changes.tags++;
            const cp = ch.codePointAt(0) - 0xE0000;
            if (cp >= 0x20 && cp <= 0x7E) decoded += String.fromCharCode(cp);
        }
        if (decoded) hidden.push(decoded);
        return '';
    });
}

function stripBom(s, changes) {
    return s.replace(/\uFEFF/g, () => { changes.invisible++; return ''; });
}

// --- segmentation ------------------------------------------------------------
//
// Three kinds. `code` (fenced and indented code blocks, inline code, the
// contents of <pre>, <code>, <script>, <style> and <textarea>) gets only the
// global passes above. `markup` (HTML tags and comments, URLs, markdown link
// destinations and reference definitions, YAML front matter) also loses
// invisible characters and stray selectors, which cannot change its syntax.
// `text` gets everything.

const RAW_OPEN_RE = /<(pre|code|script|style|textarea)\b[^>]*>/iy;
const TAG_RE = /<\/?[A-Za-z][\w:-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/y;
const DECL_RE = /<[!?][A-Za-z][^>]*>/y;
const AUTOLINK_RE = /<(?:https?|ftp|mailto):[^\s<>]*>/iy;
const LINK_DEST_RE = /\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/y;
// A URL ends at whitespace, markup, or typography no URL carries raw (a dash
// or ellipsis glued to a link is prose, and so is a curly quote).
const URL_START_RE = /(?:https?:\/\/|ftp:\/\/|www\.|mailto:)[^\s<>"'`\u2013\u2014\u2015\u2026\u2018\u2019\u201C-\u201F\u00AB\u00BB]+/iy;
const PARAGRAPH_END_RE = /\n[ \t]*\r?\n/g;

/** True when the input is an HTML document, which turns off indented-code detection. */
export function looksLikeHtmlDocument(s) {
    return /^\s*<(?:!doctype|html|head|body|div|section|article|p|h[1-6]|ul|ol|table|main|header)\b/i.test(s);
}

function splitLines(s) {
    return s.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function blockSegments(s, htmlDoc) {
    const lines = splitLines(s);
    const out = [];
    const push = (kind, text) => {
        const last = out[out.length - 1];
        if (last && last.kind === kind) last.text += text;
        else out.push({ kind, text });
    };
    let i = 0;
    if (lines.length && /^---\r?\n$/.test(lines[0])) {
        let j = 1;
        while (j < lines.length && !/^(?:---|\.\.\.)[ \t]*\r?\n?$/.test(lines[j])) j++;
        if (j < lines.length) {
            push('markup', lines.slice(0, j + 1).join(''));
            i = j + 1;
        }
    }
    let prevBlank = true;
    let inIndented = false;
    while (i < lines.length) {
        const line = lines[i];
        const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence && !(fence[1][0] === '`' && line.slice(fence[0].length).includes('`'))) {
            const close = new RegExp('^ {0,3}' + (fence[1][0] === '`' ? '`' : '~') + '{' + fence[1].length + ',}[ \\t]*\\r?\\n?$');
            let j = i + 1;
            while (j < lines.length && !close.test(lines[j])) j++;
            const end = Math.min(j, lines.length - 1);
            push('code', lines.slice(i, end + 1).join(''));
            i = end + 1;
            prevBlank = false;
            inIndented = false;
            continue;
        }
        const blank = line.trim() === '';
        if (!htmlDoc && !blank && /^(?: {4}|\t)/.test(line) && (prevBlank || inIndented)) {
            push('code', line);
            inIndented = true;
            prevBlank = false;
            i++;
            continue;
        }
        if (/^ {0,3}\[[^\]\n]+\]:[ \t]*\S/.test(line)) push('markup', line);
        else push('flow', line);
        if (!blank) inIndented = false;
        prevBlank = blank;
        i++;
    }
    return out;
}

const stickyAt = (re, t, i) => { re.lastIndex = i; return re.exec(t); };

function inlineSegments(t) {
    const out = [];
    let buf = '';
    const emit = (kind, text) => {
        if (buf) { out.push({ kind: 'text', text: buf }); buf = ''; }
        if (text) out.push({ kind, text });
    };
    let i = 0;
    while (i < t.length) {
        const c = t[i];
        if (c === '<') {
            if (t.startsWith('<!--', i)) {
                const end = t.indexOf('-->', i + 4);
                const stop = end < 0 ? t.length : end + 3;
                emit('markup', t.slice(i, stop)); i = stop; continue;
            }
            const raw = stickyAt(RAW_OPEN_RE, t, i);
            if (raw) {
                emit('markup', raw[0]);
                const bodyStart = i + raw[0].length;
                const closeRe = new RegExp('</' + raw[1] + '\\s*>', 'ig');
                closeRe.lastIndex = bodyStart;
                const close = closeRe.exec(t);
                const bodyEnd = close ? close.index : t.length;
                emit('code', t.slice(bodyStart, bodyEnd));
                if (close) emit('markup', close[0]);
                i = close ? bodyEnd + close[0].length : bodyEnd;
                continue;
            }
            const m = stickyAt(AUTOLINK_RE, t, i) || stickyAt(TAG_RE, t, i) || stickyAt(DECL_RE, t, i);
            if (m) { emit('markup', m[0]); i += m[0].length; continue; }
        } else if (c === '`') {
            let n = 1;
            while (t[i + n] === '`') n++;
            const run = '`'.repeat(n);
            PARAGRAPH_END_RE.lastIndex = i;
            const para = PARAGRAPH_END_RE.exec(t);
            const limit = para ? para.index : t.length;
            const closeRe = new RegExp('(?<!`)' + run + '(?!`)', 'g');
            closeRe.lastIndex = i + n;
            const close = closeRe.exec(t);
            if (close && close.index < limit) {
                const stop = close.index + n;
                emit('code', t.slice(i, stop)); i = stop; continue;
            }
            buf += run; i += n; continue;
        } else if (c === ']') {
            const m = stickyAt(LINK_DEST_RE, t, i);
            if (m) { buf += ']'; emit('markup', m[0].slice(1)); i += m[0].length; continue; }
        } else if (/[hwfmHWFM]/.test(c) && !/[\p{L}\p{N}_]/u.test(t[i - 1] || '')) {
            const m = stickyAt(URL_START_RE, t, i);
            if (m) {
                let url = m[0];
                // Trailing sentence punctuation is prose, unless it closes a paren the URL opened.
                while (/[.,;:!?'"\])}\u2026]$/.test(url)) {
                    if (url.endsWith(')') && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) break;
                    url = url.slice(0, -1);
                }
                emit('markup', url); i += url.length; continue;
            }
        }
        buf += c; i++;
    }
    emit('text', '');
    return out;
}

/** Split `s` into [{ kind: 'text'|'markup'|'code', text }]. Joined back, the texts equal `s`. */
export function segment(s, { htmlDoc = looksLikeHtmlDocument(s) } = {}) {
    const out = [];
    for (const block of blockSegments(s, htmlDoc)) {
        if (block.kind === 'flow') out.push(...inlineSegments(block.text));
        else out.push(block);
    }
    return out;
}

// --- per-segment passes -----------------------------------------------------

function stripInvisible(s, changes) {
    return s.replace(INVISIBLE_RE, (ch, off, whole) => {
        if (ch === '\u200D') {
            const before = codePointBefore(whole, off);
            const after = codePointAt(whole, off + 1);
            const joinsEmoji = before !== undefined && after !== undefined && isPictographic(after)
                && (isPictographic(before) || before === '\uFE0F' || /[\u{1F3FB}-\u{1F3FF}]/u.test(before));
            if (joinsEmoji) return ch;
        }
        changes.invisible++;
        return '';
    });
}

function selectorFits(base, vs) {
    if (base === undefined || /\s/.test(base)) return false;
    const cp = vs.codePointAt(0);
    if (cp === 0xFE0E || cp === 0xFE0F) return isEmoji(base);
    if (cp >= 0xE0100) return /\p{Script=Han}/u.test(base);
    return /[\p{Sm}\p{So}\p{Script=Han}\p{Script=Myanmar}\p{Script=Phags_Pa}]/u.test(base);
}

// One selector the base character takes is presentation. A run of them after
// one base, or one after a base that takes none, is data hidden in plain sight.
function stripSelectors(s, changes) {
    return s.replace(SELECTOR_RUN_RE, (run, off, whole) => {
        const selectors = [...run];
        const keep = selectorFits(codePointBefore(whole, off), selectors[0]) ? selectors[0] : '';
        changes.variationSelectors += selectors.length - (keep ? 1 : 0);
        return keep;
    });
}

function fixDiacritics(s, changes) {
    return s
        .replace(/[şŞţŢ]/g, (ch) => { changes.diacritics++; return COMMA_BELOW[ch]; })
        .replace(/([sStT])[\u0327\u0326]/g, (_, base) => { changes.diacritics++; return COMMA_BELOW[base]; });
}

function fixSpaces(s, changes, ctx) {
    const plain = s.replace(ODD_SPACE_RE, () => { changes.spaces++; return ' '; });
    return plain.replace(/\u00A0/g, (ch, off, whole) => {
        const after = whole.slice(off + 1, off + 8);
        const before = off > 0 ? whole[off - 1] : ctx.prevChar;
        if (NBSP_KEEP_AFTER_RE.test(after)) return ch;
        if (before !== undefined && /\d/.test(before) && UNIT_RE.test(after)) return ch;
        changes.spaces++;
        return ' ';
    });
}

function fixEllipsis(s, changes) {
    return s.replace(/\u2026/g, () => { changes.ellipsis++; return '...'; });
}

function fixDashes(s, changes, ctx, mode) {
    if (mode === 'keep') return s;
    // Ranges: 10–20, 10 – 20 and 2020—2024 become 10-20.
    const ranged = s.replace(/(\d)(?:[ \t]*[\u2013\u2012][ \t]*|\u2014)(?=\d)/g, (_, d) => { changes.dashes++; return d + '-'; });
    // An unspaced en dash between words (Mon–Fri) is a hyphen's job.
    const joined = ranged.replace(/(?<=[^\s\u2013\u2014\u2015])\u2013(?=[^\s\u2013\u2014\u2015])/g, () => { changes.dashes++; return '-'; });
    return joined.replace(/[ \t]*[\u2014\u2015\u2013][ \t]*/g, (m, off, whole) => {
        const p = off > 0 ? whole[off - 1] : ctx.prevChar;
        const n = off + m.length < whole.length ? whole[off + m.length] : ctx.nextChar;
        if (isLineBreak(p)) return m; // a line-leading dash is list or dialogue syntax: flagged, not rewritten
        changes.dashes++;
        if (isLineBreak(n)) return '';
        if (/[,;:.!?]/.test(p)) return ' ';
        if (/[(\[{"'\u201E\u201C\u00AB]/.test(p)) return '';
        if (/[,;:.!?)\]}"'\u201D\u00BB]/.test(n)) return '';
        return mode === 'hyphen' ? ' - ' : ', ';
    });
}

const QUOTE_OPEN_BEFORE = /[\s(\[{>*_\u2014\u2013-]/;

function fixQuotes(s, changes, ctx, locale) {
    if (locale === 'en') {
        return s
            .replace(/[\u201C\u201D\u201E\u201F]/g, () => { changes.quotes++; return '"'; })
            .replace(/[\u2018\u2019\u201A\u201B]/g, () => { changes.quotes++; return "'"; });
    }
    // Romanian: „ opens and ” closes, whichever curly form the model used.
    const curly = s.replace(/[\u201C\u201D\u201E\u201F]/g, (ch, off, whole) => {
        const p = off > 0 ? whole[off - 1] : ctx.prevChar;
        const n = off + 1 < whole.length ? whole[off + 1] : ctx.nextChar;
        const opens = (p === undefined || QUOTE_OPEN_BEFORE.test(p)) && n !== undefined && !/\s/.test(n);
        const want = opens ? '\u201E' : '\u201D';
        if (want !== ch) changes.quotes++;
        return want;
    });
    // Straight quotes only as a pair on one line, opening at a word boundary.
    return curly.replace(/(^|[\s(\[{>*_\u2014\u2013-])"(\S(?:[^"\n]*?\S)?)"(?=$|[\s)\]}.,;:!?*_<-])/gm, (m, lead, body, off) => {
        if (off === 0 && lead === '' && ctx.prevChar !== undefined && !QUOTE_OPEN_BEFORE.test(ctx.prevChar)) return m;
        changes.quotes += 2;
        return lead + '\u201E' + body + '\u201D';
    });
}

function fixWhitespace(s, changes, ctx) {
    // Trailing runs. A markdown hard break (2+ spaces after content, before a
    // newline) is kept as exactly two spaces; every other trailing run goes.
    const trimmed = s.replace(/[ \t]+(?=\r?\n|$)/g, (run, off, whole) => {
        const atEnd = off + run.length === whole.length;
        if (atEnd && !isLineBreak(ctx.nextChar)) return run; // markup follows on this line
        const lineStart = off === 0 ? 0 : whole.lastIndexOf('\n', off - 1) + 1;
        const hasContent = off > lineStart || (lineStart === 0 && !ctx.lineStart);
        if (!ctx.htmlDoc && hasContent && !atEnd && /^ {2,}$/.test(run)) {
            if (run === '  ') return run;
            changes.whitespace++;
            return '  ';
        }
        changes.whitespace++;
        return '';
    });
    // Inner runs of spaces. Leading indentation is never touched.
    return trimmed.replace(/ {2,}/g, (run, off, whole) => {
        const atLineStart = off === 0 ? ctx.lineStart : whole[off - 1] === '\n';
        if (atLineStart) return run;
        const next = off + run.length < whole.length ? whole[off + run.length] : ctx.nextChar;
        if (isLineBreak(next) || next === '\r') return run; // a kept hard break
        changes.whitespace++;
        return ' ';
    });
}

// --- flags --------------------------------------------------------------------

const RO_LOOSE = { 'ș': '[șşs]', 'ş': '[șşs]', 'ț': '[țţt]', 'ţ': '[țţt]', 'ă': '[ăa]', 'â': '[âa]', 'î': '[îi]' };

/** The RegExp a phrase entry matches with. Exported so a project can test its own entries. */
export function phraseRegex(entry) {
    if (entry instanceof RegExp) return new RegExp(entry.source, entry.flags.includes('g') ? entry.flags : entry.flags + 'g');
    const str = String(entry).trim();
    const wildcard = str.endsWith('*');
    let src = '';
    for (const ch of wildcard ? str.slice(0, -1) : str) {
        const loose = RO_LOOSE[ch.toLowerCase()];
        if (loose) src += loose;
        else if (ch === "'" || ch === '\u2019') src += "['\u2019]";
        else if (/\s/.test(ch)) src += '\\s+';
        else src += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
    if (wildcard) src += '[\\p{L}\\p{N}]*';
    return new RegExp('(?<![\\p{L}\\p{N}])' + src + '(?![\\p{L}\\p{N}])', 'giu');
}

// --- the entry point ------------------------------------------------------------

/**
 * Clean `input`.
 * @param {string} input
 * @param {{ locale?: 'en'|'ro', dashes?: 'comma'|'hyphen'|'keep', html?: 'auto'|boolean, phrases?: Array<string|RegExp> }} [options]
 * @returns {{ text: string, changes: Record<string, number>, flags: Array<{ phrase: string, match: string, index: number }>, hiddenTagText: string }}
 */
export function cleanText(input, options = {}) {
    if (typeof input !== 'string') throw new TypeError('cleanText: input must be a string');
    const locale = options.locale === undefined ? 'en' : options.locale;
    const dashes = options.dashes === undefined ? 'comma' : options.dashes;
    if (!LOCALES.includes(locale)) throw new RangeError(`cleanText: locale must be one of ${LOCALES.join(', ')}, got ${JSON.stringify(locale)}`);
    if (!DASH_MODES.includes(dashes)) throw new RangeError(`cleanText: dashes must be one of ${DASH_MODES.join(', ')}, got ${JSON.stringify(dashes)}`);
    const phrases = Array.isArray(options.phrases) ? options.phrases : AI_PHRASES;

    const changes = Object.fromEntries(CHANGE_CLASSES.map((k) => [k, 0]));
    const hidden = [];

    let s = stripBidi(input, changes);
    s = stripTags(s, changes, hidden);
    s = stripBom(s, changes);

    const htmlDoc = options.html === undefined || options.html === 'auto' ? looksLikeHtmlDocument(s) : Boolean(options.html);
    const segs = segment(s, { htmlDoc });

    const outParts = [];
    const textRanges = [];
    let pos = 0;
    segs.forEach((seg, k) => {
        let v = seg.text;
        if (seg.kind !== 'code') {
            v = stripInvisible(v, changes);
            v = stripSelectors(v, changes);
        }
        if (seg.kind === 'text') {
            // Context comes from the neighbours as they were before cleaning.
            // Only their edge characters are read, and those are never text.
            const prevSeg = segs[k - 1];
            const nextSeg = segs[k + 1];
            const ctx = {
                prevChar: prevSeg ? prevSeg.text[prevSeg.text.length - 1] : undefined,
                nextChar: nextSeg ? nextSeg.text[0] : undefined,
                lineStart: !prevSeg || prevSeg.text.endsWith('\n'),
                htmlDoc,
            };
            if (locale === 'ro') v = fixDiacritics(v, changes);
            v = fixSpaces(v, changes, ctx);
            v = fixEllipsis(v, changes);
            v = fixDashes(v, changes, ctx, dashes);
            v = fixQuotes(v, changes, ctx, locale);
            v = fixWhitespace(v, changes, ctx);
            textRanges.push([pos, v]);
        }
        outParts.push(v);
        pos += v.length;
    });
    const text = outParts.join('');

    const flags = [];
    const regexes = phrases.map((entry) => [String(entry), phraseRegex(entry)]);
    for (const [start, v] of textRanges) {
        for (const [phrase, re] of regexes) {
            for (const m of v.matchAll(re)) flags.push({ phrase, match: m[0], index: start + m.index });
        }
        if (dashes !== 'keep') {
            for (const m of v.matchAll(/(?<=^|\n)[ \t]*([\u2014\u2015])/g)) {
                flags.push({ phrase: 'line-leading em dash', match: m[1], index: start + m.index + m[0].length - 1 });
            }
        }
    }
    flags.sort((a, b) => a.index - b.index);

    return { text, changes, flags, hiddenTagText: hidden.join('\n') };
}

// --- CLI ------------------------------------------------------------------------

const USAGE = `Usage: node text-hygiene.mjs [options] <file|->

Clean AI-generated text before publishing: remove invisible and smuggling
characters, normalise dashes, ellipses, quotes and spaces, and flag stock
AI phrases for a human to rewrite. Reads a file, or stdin when given "-".

Options:
  --locale en|ro               quote and diacritic rules (default en)
  --dashes comma|hyphen|keep   what an em dash becomes (default comma)
  --check                      write nothing; exit 1 if anything would change
  --json                       print {changed, text, changes, flags, hiddenTagText}
  -h, --help                   this text

Exit: 0 done (or clean under --check), 1 --check found changes, 2 bad input.
Without --check the cleaned text goes to stdout and a summary to stderr,
which stays empty when there was nothing to change or flag.
Statistical watermarks live in word choice; no character filter removes them.
`;

function builtin(name) {
    if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') return process.getBuiltinModule(name);
    return null;
}

function parseArgs(argv) {
    const opts = { locale: 'en', dashes: 'comma', check: false, json: false, help: false, file: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = (name) => {
            const eq = a.indexOf('=');
            if (eq > 0) return a.slice(eq + 1);
            if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
            i++;
            return argv[i];
        };
        if (a === '-h' || a === '--help') opts.help = true;
        else if (a === '--check') opts.check = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--locale' || a.startsWith('--locale=')) opts.locale = value('--locale');
        else if (a === '--dashes' || a.startsWith('--dashes=')) opts.dashes = value('--dashes');
        else if (a === '-' || !a.startsWith('-')) {
            if (opts.file !== null) throw new Error('give exactly one input (a file or -)');
            opts.file = a;
        } else throw new Error(`unknown option ${a}`);
    }
    if (!LOCALES.includes(opts.locale)) throw new Error(`--locale must be one of ${LOCALES.join(', ')}`);
    if (!DASH_MODES.includes(opts.dashes)) throw new Error(`--dashes must be one of ${DASH_MODES.join(', ')}`);
    if (!opts.help && opts.file === null) throw new Error('no input: give a file, or - for stdin');
    return opts;
}

function flagLines(result) {
    return result.flags.map((f) => `  flag at ${f.index}: ${JSON.stringify(f.match)} (${f.phrase})\n`).join('');
}

function summarise(result, name, verb) {
    const parts = CHANGE_CLASSES.filter((k) => result.changes[k]).map((k) => `${k} ${result.changes[k]}`);
    let out = `text-hygiene: ${name}: ${parts.length ? verb + ' ' + parts.join(', ') : 'no character changes'}\n`;
    if (result.hiddenTagText) out += `  hidden tag text removed: ${JSON.stringify(result.hiddenTagText)}\n`;
    return out + flagLines(result);
}

/** The CLI with its I/O injected: `io.read(file|'-') -> Uint8Array`, `io.stdout(s)`, `io.stderr(s)`. Returns the exit code. */
export function runCli(argv, io) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (e) {
        io.stderr(`text-hygiene: ${e.message}\n\n${USAGE}`);
        return 2;
    }
    if (opts.help) { io.stdout(USAGE); return 0; }

    const name = opts.file === '-' ? 'stdin' : opts.file;
    let input;
    try {
        input = new TextDecoder('utf-8', { fatal: true }).decode(io.read(opts.file));
    } catch (e) {
        io.stderr(`text-hygiene: cannot read ${name} as UTF-8: ${e.message}\n`);
        return 2;
    }

    const result = cleanText(input, { locale: opts.locale, dashes: opts.dashes });
    const changed = result.text !== input;

    if (opts.json) {
        io.stdout(JSON.stringify({ changed, ...result }, null, 2) + '\n');
        return opts.check && changed ? 1 : 0;
    }
    if (opts.check) {
        if (changed) { io.stdout(summarise(result, name, 'would change')); return 1; }
        io.stdout(`text-hygiene: ${name}: clean, ${input.length} characters scanned, locale ${opts.locale}, ${result.flags.length} phrase flag(s)\n` + flagLines(result));
        return 0;
    }
    io.stdout(result.text);
    if (changed || result.flags.length) io.stderr(summarise(result, name, 'changed'));
    return 0;
}

function isMain() {
    const url = builtin('url');
    const fs = builtin('fs');
    if (!url || !fs || !process.argv[1]) return false;
    try {
        const norm = (p) => {
            const real = fs.realpathSync.native(p);
            return process.platform === 'win32' ? real.toLowerCase() : real;
        };
        return norm(process.argv[1]) === norm(url.fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isMain()) {
    const fs = builtin('fs');
    process.exitCode = runCli(process.argv.slice(2), {
        read: (file) => fs.readFileSync(file === '-' ? 0 : file),
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
    });
}
