# Browser verification

The steps auto uses to drive a page with the built-in browser tools when a task touched UI.

Drive the page with the built-in browser tools:

1. `navigate` to the page.
2. `read_page` — the accessibility tree, and the assertion surface. Cheaper and more
   reliable than a screenshot for text and structure.
3. `computer` `screenshot` for the desktop view.
4. `resize_window` `{preset: 'mobile'}`, reload, then screenshot again.
5. `read_console_messages` `{onlyErrors: true}`.

**Two viewports, not one.** Check 390px *and* 414px — a layout can survive one and
break the other. And `resize_window`'s mobile preset changes the viewport and the
user agent, which is enough for a CSS breakpoint but not proof that a load-time
*device* gate fired; when the code branches on device rather than width, use
chrome-devtools `emulate` and reload so those gates re-run.

**Assert the viewport you think you measured.** A resize tool can report success
while the page never changed, which turns "I verified the mobile layout" into a
desktop screenshot with a mobile label. Read `window.innerWidth` in the same call
that takes the measurement.

If the browser tools are unavailable, `WebFetch` verifies that a page loads at all —
say that is what you did, and do not describe it as visual verification.
