# The done bar

A site is not done when it works. Working is the floor. It is done when it holds
all six items below, each with evidence on the tested candidate.
`[stated 2026-09-26]` by the operator as a standing rule.

The bar applies to a product with a user-facing surface: a site, an app, a page
people visit. A CLI, a library or a hook is judged by `rule-verification` alone.

The bar judges the PRODUCT, not each story. A story still closes on its own check
under `rule-verification`. The bar decides whether the product, or a release
announced as finishing it, may be called done.

| Item | Done means | Evidence |
|---|---|---|
| 1. Special | It is unique and has flair: at least one signature moment tied to what the product is for, which a comparable product lacks. The delight pass (`brainstorm`, Step 5) has been offered and answered. | The named moment and where it lives, plus the operator's pick on the options artifact. A touch nobody chose does not count. |
| 2. Functions perfectly | Every flow works for the intended roles and data, in its loading, empty, error and success states, and survives a reload. No console errors or failed requests during the flows. | `rule-verification`'s UI row: driven flows with state assertions, console and network read. |
| 3. Looks perfectly | Nothing clipped, overlapping or overflowing. Text fits its container. Sibling sections share one column width, and a control row does not wrap when one row fits. Every supported theme reads. Favicon, logo and link-preview card render. | Inspected screenshots at 390, 414 and desktop in each theme, and the `design` skill's quality gate. |
| 4. Animates perfectly | Motion runs on `transform` and `opacity`, shifts no layout, holds its frame rate on a throttled phone profile and ends on the true value. It is off or reduced under `prefers-reduced-motion`, and paused off screen and in a hidden tab. | A recording or trace of each animated moment, one run with reduced motion emulated, and a layout-shift reading. |
| 5. Secure | The `security` skill's review and ship's Step 2 checklist pass on the candidate. | Their output, bound to the candidate SHA. |
| 6. Tested alone and together | Every feature has a test of its own through its real entry point. At least one test also drives the features together in one session, the way a person uses them: the output of one feeding the next, then a reload. | The test per feature, the combined test, and their runs on the candidate. A suite of isolated tests is half of this item. |

## Reading a miss

An unmet item is open work, never a waiver. Ship names it in its report, audit
files the defects it owns, and iterate does not call a round converged while one
is open. The operator can accept a miss explicitly. Record that as a `deferred`
decision with its reason, not as a pass.

Item 1 closes only on the operator's pick, so no agent can close it alone. An
unanswered delight panel leaves the product working and not done, which is the
accurate state.
