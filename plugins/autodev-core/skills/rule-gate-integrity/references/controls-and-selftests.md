# Controls and selftests that can actually fail

This file holds sections 11 and 12 of rule-gate-integrity: a control that shares a mechanism with its subject, and a selftest that exists but never runs.

## 11. A control must not share a mechanism with its subject

Section 1 is about grading a COPY. This is the mirror image: grading the real
thing, with the real thing. The control runs the actual implementation — so it
passes every check in section 1 — and still cannot fail, because it inherits the
subject's blind spot exactly.

`[measured 2026-09-08]` A comment stripper in a production repo blanked comments
so a checker would read code and not prose about code. Its completeness control
was:

```js
export function hasComment(text, fileName) {
  return commentRanges(text, fileName).length > 0;   // the function under test
}
```

`blankComments` uses `commentRanges` to decide what to blank. `hasComment` then
used `commentRanges` to ask whether anything had been missed. A comment the range
walk cannot see is a comment it does not blank AND a comment the control does not
find. Over 198 real files, with each of the two range functions dropped in turn:

```
getTrailingCommentRanges dropped ->  146 comments survive in  44 of 198 files
getLeadingCommentRanges dropped  -> 1012 comments survive in 120 of 198 files
```

and the control reported **zero survivors across all 198 files in both cases**.
The first mutation was not hypothetical — it was the bug that implementation had
actually shipped in its first draft. The single piece of evidence that blanking
was complete would have gone green on the defect it existed to catch.

The companion population figure did not help: "186 of 198 files have a comment"
stayed at 185 and 180 under the two mutations, because it asked the same
function. **A population floor (section 2) drawn with the subject's own
mechanism is not independent of the subject.**

The fix is a DIFFERENT MECHANISM, not a second opinion from the same one. There
the subject asked a parser API where the comments are; the control walks the tree
and reads the raw text between each terminal token's `getFullStart()` and its
`getStart()` — the trivia span, by definition everything the parser did not turn
into a token. Anything the range functions miss still lands in that span. After
the change the same two mutations turn it red on 44 and on 120 files.

**The question to ask**: if the subject has a blind spot, does the control look
through the same eye? Sharing a PARSE is fine — both walks can use one syntax
tree. Sharing the API whose contract can be misread is the defect.

And a control needs both halves. "Nothing survived" is also what a function that
returns false says, so measure the positive: this one is true for 186 of the 198
files before blanking and 0 after.

## 12. Asserting that a control EXISTS is not running it

A selftest proves a checker can fail. A test that reads the checker's SOURCE and
asserts the selftest is present proves only that somebody typed it.

`[measured 2026-09-08]` Two of eight gate steps in a production repo shipped a
substantial selftest — planted violations, both directions, a clean fixture
required to stay silent. Nothing in the repository ever ran either one: not the
gate, not CI, not a test. Standing in for execution was

```js
const gate = readFileSync("scripts/a11y-check.mjs", "utf8");
it("has a selftest, because a checker nobody has seen fail may be unable to", () => {
  expect(gate).toContain("--selftest");
});
```

Narrowing that checker's heading rule from `!== 1` to `< 1` — a real defect, and
precisely the one its selftest plants:

```
node scripts/a11y-check.mjs --selftest   ->  FAIL, h1=false, exit 2
npx vitest run tests/seo.test.ts         ->  76 of 76 PASS
```

The control worked. The test named after the control did not run it. And the
gate step could not catch the defect independently, because it passes on the real
site with the correct rule — every page has exactly one heading, so a rule firing
only below one is indistinguishable from the right one on that corpus.

Note what the source-text test does buy: deleting the selftest function turned it
red, because the same test also asserted a string that lived inside the function.
That is why it survived so long. **It detects deletion and is blind to breakage**,
which is the worst ratio for a guard to have, because deletion is the failure
nobody commits and breakage is the one everybody does.

The repair is not a better source-text assertion. It is to make the control run
on the path the gate actually takes — in that repo the one step whose selftest
worked was the one that ran it inline at module load, on every invocation, rather
than behind a flag. A flag nobody passes is not an entry point.

**Ask of every selftest: name the command that executes it.** If the answer is
its own `--selftest` flag, grep for who passes that flag before believing it.
