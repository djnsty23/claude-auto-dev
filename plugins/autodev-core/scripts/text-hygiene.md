# text-hygiene.mjs

A dependency-free cleaner for AI-generated text that is about to be published:
blog articles, offer documents, emails. It removes the hidden character-level
marks that model output and copy-paste carry, normalises the typographic tells,
and reports stock AI phrases for a human or a model to rewrite.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/text-hygiene.mjs --locale ro article.md > article.clean.md
node ${CLAUDE_PLUGIN_ROOT}/scripts/text-hygiene.mjs --check article.md   # exit 1 if anything would change
cat draft.txt | node ${CLAUDE_PLUGIN_ROOT}/scripts/text-hygiene.mjs --json -
```

```js
import { cleanText, AI_PHRASES } from './text-hygiene.mjs';
const { text, changes, flags, hiddenTagText } = cleanText(draft, { locale: 'ro', dashes: 'comma' });
```

## What it changes

Each class is counted separately in `changes`.

| key | what | rule |
|---|---|---|
| `invisible` | U+200B, U+200C, U+200D, U+2060 to U+2064, U+FEFF, U+180E, U+00AD, U+034F, U+115F, U+1160, U+3164, U+FFA0 | removed. U+200D stays inside emoji ZWJ sequences |
| `bidi` | U+202A to U+202E, U+2066 to U+2069, and the marks U+200E, U+200F, U+061C | removed: they can reorder the visible text |
| `tags` | U+E0000 to U+E007F | removed, and the ASCII they spelled is returned in `hiddenTagText`. The three RGI subdivision flags (England, Scotland, Wales) are kept |
| `variationSelectors` | U+FE00 to U+FE0F, U+E0100 to U+E01EF | one selector the base character takes (an emoji's VS16, a Han ideograph's IVS) is kept. A run after one base, or a selector after a base that takes none, is removed |
| `spaces` | U+2002 to U+200A, U+202F, U+205F, U+3000 | become a space. U+00A0 stays before `%`, `€`, `lei`, `RON` and between a number and its unit (or a digit group), otherwise it becomes a space |
| `dashes` | em dash, horizontal bar, spaced en dash | `--dashes comma` (default) gives `, `, `hyphen` gives ` - `, `keep` leaves them. A dash between digits (`10–20`) or unspaced between words (`Mon–Fri`) becomes `-`. A dash that starts a line is left and flagged, because rewriting it would make a markdown list |
| `ellipsis` | U+2026 | becomes `...` |
| `quotes` | curly quotes | `en`: straight. `ro`: `„…”` pairs, from curly quotes and from straight `"…"` pairs on one line |
| `diacritics` | `ş Ş ţ Ţ` (cedilla) and decomposed forms | `ro` only: `ș Ș ț Ț` (comma below). Search engines treat the two forms as different letters |
| `whitespace` | runs of 2+ spaces inside a line, trailing spaces and tabs | collapsed and stripped. Leading indentation is never touched. A markdown hard break (2+ trailing spaces before another line) is kept as exactly two spaces |

`flags` lists stock phrases (`delve`, "in today's fast-paced world", "it's
worth noting", "în concluzie", "nu în ultimul rând", "Great question" and more)
as `{ phrase, match, index }`, with `index` into the cleaned text. They are
never rewritten. The list is the exported `AI_PHRASES` array: push to it, or pass
`options.phrases`. Matching ignores case and accepts Romanian words typed without
diacritics.

## What it leaves alone

The typographic passes run on prose only. Code (fenced and indented blocks,
inline code, and `<pre>`, `<code>`, `<script>`, `<style>`, `<textarea>`
contents) is never touched, except that bidi controls and tag characters are
removed everywhere: those are the two classes an attacker uses, and a code
sample is where a hidden instruction would hide. HTML tags and attributes,
URLs, markdown link destinations and titles, reference definitions and YAML
front matter only lose invisible characters and stray selectors, which cannot
change their syntax.

Known limits of the scanner, which is a few regular expressions rather than a
parser: a paragraph indented four spaces inside a list item is read as a code
block and left as it is, and when the input starts with an HTML element,
indented-code detection is off (`options.html` overrides the guess). HTML
entities such as `&mdash;` are not decoded. U+200C and U+200D are also removed
from scripts that use them as letters (Persian, Indic), so do not run it on
those languages.

## What it cannot do

Statistical watermarks, such as Google's SynthID-Text, live in which words the
model chose, not in any character. No character filter removes them, and this
tool does not try. Only an actual rewrite by a person or a model changes that.
The phrase flags point at the most obvious tells. They do not make text read as
human.

## Vendoring

Copy the single file. It has no dependencies and no static imports, so a
bundler does not pull Node built-ins into a client bundle: the CLI half reaches
`fs` and `url` through `process.getBuiltinModule` (Node 20.16 or 22.3 and
later), and only when the file is the process entry point. In a Next.js app,
import `cleanText` in server code or a build script. The CLI's `--check` exit
code (0 clean, 1 would change, 2 bad input) is meant for a pre-publish gate.

Tests: `tooling/test-text-hygiene.js`.
