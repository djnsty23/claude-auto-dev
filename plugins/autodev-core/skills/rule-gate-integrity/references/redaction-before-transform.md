# Redact before you transform

This file holds section 14 of rule-gate-integrity: the measured redaction leak through transforms, the detector with the same bug, and the canary shapes that catch it.

## 14. Redact BEFORE you transform, and search for the TRANSFORMED value

`[measured 2026-09-08]` a shipped collector scrubbed credentials out of everything
it wrote by holding the secret's value in a set and doing
`text.split(value).join('[REDACTED]')`. It ran that scrub over **serialised
JSON**. A secret containing a `"` was already `\"` in the serialised text, so the
raw value was not present, no replacement happened, and the credential landed in
the report, the ledger and the candidates file — recoverable with one
`JSON.parse`. The suite asserted `!everything.includes(CANARY)` and was green,
because the canary was `sk-live-CANARY-7Qz9pX2mLr41`: **JSON-safe by
construction, so the assertion could not fail for the defect it named.**

The fix registered the escaped form alongside the raw one. That closed the
demonstrated case and not the class, because the root cause was never JSON
escaping — it is that **redaction ran after a transform, while the redactor only
knew untransformed forms.** Two more transforms in the same file were still live
after the fix:

```
clip(s, n) { const t = String(s).replace(/\s+/g, ' ').trim();
             return t.length <= n ? t : t.slice(0, n - 1) + '…'; }
```

- **whitespace collapse** — a secret containing a newline became `SEC NEWLINE-1234`
  in the output. Neither registered form matched. **Full disclosure.**
- **truncation** — a 172-character secret was clipped to 140 before the scrub, so
  115 characters survived in plaintext. **Partial disclosure.**

Multi-line secrets are ordinary: PEM private keys, service-account JSON, base64
wrapped at 64 columns.

**So:** scrub at the point values ENTER the record — walk the object and replace
on string leaves before `clip`, before `JSON.stringify` — rather than scrubbing
the rendered text afterwards. Registering each transform's output is whack-a-mole,
and the next transform added to the file re-opens it silently, with no test going
red.

### The detector has the same bug, and that is the harder half

Checking whether a secret survived, the obvious command is

```bash
grep -F "$SECRET" out/*        # reports "clean"
```

and it is **wrong for exactly the reason the subject was wrong**: in a JSON file
the value is stored escaped, so grepping the raw form misses a secret that is
fully present. `[measured 2026-09-08]` this was hit three times in one session —
twice by a reviewer auditing the code above, once in the code itself. A "clean"
result from a detector that searches the pre-transform value is not evidence.

Two rules follow, and the second is the one that saves you:

1. **Search for every form the pipeline can produce** — raw, JSON-escaped,
   whitespace-collapsed, truncated — or better, parse the artefact and inspect
   the DECODED string values rather than the bytes.
2. **Assert the positive marker, not the absence of the string you fear.** A
   report containing the leaky field and **zero `[REDACTED]` markers** is
   inconsistent with a successful scrub, and that inconsistency is what exposed
   the surviving variants. Absence of a match has two causes — it was redacted,
   or you looked for the wrong string — and only the marker tells them apart.
   This is §2's population floor pointed at a redactor.

### The canary must carry every shape the transforms can alter

A canary widened to the *reported* defect fires for the two shapes that were
demonstrated and stays green for the ones that were not. After the fix above the
canary was `sk-live-CANARY-7Qz9\pX"2mLr41` — a quote and a backslash, exactly the
two variants named in the review — with no whitespace and short enough never to
be clipped. Both remaining variants were invisible to it.

Give the canary a `"`, a `\`, a newline, and enough length to be truncated. Then
assert on the decoded values of what was written, not on its bytes. The general
form is §3's rule with a sharper edge: it is not enough that the canary CAN fire;
it must be able to fire **for every mechanism the code path contains**.
