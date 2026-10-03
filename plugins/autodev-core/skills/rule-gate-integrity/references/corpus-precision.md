# Measuring a gate's precision on the real corpus

This file holds section 7 of rule-gate-integrity: why a selftest is not precision, the worked negative behind it, and how to prove a suppressor can fire.

## 7. Measure precision on the real corpus before wiring anything

A gate earns its wiring with a triaged first run, never with a passing
selftest. The selftest proves the check CAN fire. Only the corpus says
whether what it catches is worth reading.

**A worked negative, kept because the result is the useful part.** A
reviewer found a real defect no suite here could see: a document that
denied a thing in one paragraph and measured it in another, where each
sentence was individually plausible and only their conjunction was false.
A detector for that shape was written, and it passed a careful selftest
8 of 8, including the real defect planted verbatim and the fixed text
staying quiet.

Then it met the corpus: **204 hits over 123 files, and 12 of the first 12
triaged by hand were false.** Every one paired unrelated paragraphs -- "no
releases" in one changelog entry against "releases" in a different entry
forty paragraphs later. The check matched a shared noun; the question was
whether two statements are about the same subject, and a string comparison
cannot answer it.

Three things that generalise past this one check:

- **A selftest measures the author's imagination.** Both the positive and
  the negatives were cases considered while writing it. The corpus
  supplies the cases that were not.
- **Fix your own bugs before condemning the class.** The first sweep
  flagged `the`, `from`, `its`: the capture took the token after the
  negation, which is often a determiner. That was 24 hits of author error
  masquerading as evidence about the problem. Removing them moved 228 to
  204 and changed no conclusion, but the conclusion was only trustworthy
  after.
- **A detector at zero precision is worse than none**, and the reason is
  the same one that makes a reassuring skip worse than silence: a check
  people mute stops catching the real thing later. Ship the negative
  result instead. "This class needs a semantic comparison, here is the
  measurement that says so" is a finding.

### Counting how often a suppressor FIRED is not measuring whether it CAN

A census over the corpus answers "how much does this rule change the output".
It does not answer "does this rule work", and the two come apart exactly where
it matters: **a suppressor that fires zero times looks unexercised and may be
incapable.** Both produce the same number, and the reassuring reading is the
one a census invites.

`[measured 2026-09-07]` A staleness detector grew a veto so that
`NO prod tag is pending` -- a sentence asserting the ABSENCE of open work, in
the exact grammar of asserting its presence -- would not be reported. The veto
allowed one token between `no` and the verb. The subject is a noun phrase, so
it never matched the sentence it was written for, and it vetoed nothing.

The fleet census scored it **0 firings**. That was read as "defensive, not yet
needed on this corpus". It meant "structurally cannot match anything". The two
were indistinguishable from the measurement, and the sentence that motivated
the veto was sitting in the corpus being counted, unmatched.

What separated them was a mutation: **deleting the veto entirely left the suite
green**, which is the signal that the assertion guarding it never reached it.
Chasing that survivor found the defect in the subject.

- A veto, a filter, an allowlist carve-out -- anything that can only REMOVE
  output -- needs a case proving it removes something, not a count of how often
  it did.
- Assert the intermediate, not the outcome. "This row matches the pattern AND
  matches the veto" fails loudly when either half stops being true; "this row is
  not reported" passes just as happily when the row never matched anything.
- **A zero in a census is two claims wearing one number.** Before recording a
  rule as unexercised, run one input through it by hand and watch it fire.
