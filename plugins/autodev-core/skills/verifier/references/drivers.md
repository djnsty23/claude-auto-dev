# Driver skeletons and the project skill template

Starting points for `verifier` Step 3 and Step 5. Each skeleton is a shape to
fill from what Step 1 discovered, not a file to copy unread. Replace every
`<placeholder>` and delete flows the app does not have.

## Contents

- Shared lifecycle
- Web UI flows
- HTTP API flows
- CLI flows
- Project skill template

## Shared lifecycle

Start the app, wait for readiness, always kill the process tree. On Windows a
plain `kill` ends only the shell wrapper, so the tree is killed with `taskkill`.

```js
// driver.mjs
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const only = opt('flow')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join('.claude', 'reports', 'verify', stamp)
mkdirSync(outDir, { recursive: true })

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  else process.kill(-child.pid, 'SIGTERM')
}

async function startApp() {
  if (opt('base')) return { base: opt('base'), child: null }
  const port = await freePort()
  const child = spawn('<start command>', ['<args>'], {
    env: { ...process.env, PORT: String(port) },
    shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore',
  })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try { if ((await fetch(base)).status < 500) return { base, child } } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  killTree(child)
  console.log(`COULD NOT RUN: no readiness at ${base} within 90 s`)
  process.exitCode = 2
  return null
}
```

The flow runner shared by every surface:

```js
const results = []
async function run(name, fn) {
  if (only && only !== name) return
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`) }
  catch (e) { results.push({ name, ok: false }); console.log(`FAIL ${name}: ${e.message}`) }
}
function expect(cond, message) { if (!cond) throw new Error(message) }

function finish() {
  const failed = results.filter((r) => !r.ok).length
  console.log(`flows run: ${results.length}, failed: ${failed}, evidence: ${outDir}`)
  if (!results.length) { console.log('COULD NOT RUN: no flow matched'); process.exitCode = 2 }
  else if (process.exitCode !== 2) process.exitCode = failed ? 1 : 0
}
```

A run with zero flows exits 2. An empty run is not a pass.

## Web UI flows

```js
import { chromium } from 'playwright'

const WIDTHS = [390, 414, 1280]
const ALLOWED_CONSOLE = [
  // /pattern/, // reason this error is accepted
]

async function webFlow(browser, base, name, steps) {
  await run(name, async () => {
    for (const width of WIDTHS) {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      const problems = []
      page.on('console', (m) => {
        if (m.type() === 'error' && !ALLOWED_CONSOLE.some((re) => re.test(m.text()))) problems.push(`console: ${m.text().slice(0, 160)}`)
      })
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 160)}`))
      page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`))
      page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`) })
      try {
        await steps(page, base)
        expect(await page.evaluate(() => innerWidth) === width, `viewport is not ${width}`)
        await page.screenshot({ path: path.join(outDir, `${name}-${width}.png`), fullPage: true })
        expect(problems.length === 0, `at ${width}: ${problems.join(' | ')}`)
      } finally { await page.close() }
    }
  })
}

const app = await startApp()
if (app) {
  const browser = await chromium.launch({ headless: true })
  try {
    await webFlow(browser, app.base, '<flow-name>', async (page, base) => {
      await page.goto(`${base}/<path>`)
      await page.getByRole('button', { name: '<visible label>' }).click()
      await page.getByText('<text the user sees after>').waitFor({ timeout: 10_000 })
      expect(new URL(page.url()).pathname === '/<expected path>', `landed on ${page.url()}`)
    })
  } finally { await browser.close(); killTree(app.child) }
  finish()
}
```

A sign-in flow reads its test values from the environment, which the run
command fills from the project's seed or example config:

```js
const email = process.env.VERIFY_EMAIL
const password = process.env.VERIFY_PASSWORD
if (!email || !password) { console.log('NEEDS SETUP: VERIFY_EMAIL and VERIFY_PASSWORD from <seed file>'); process.exitCode = 2 }
```

Never log either value. Log only that each is present.

## HTTP API flows

```js
const app = await startApp()
if (app) {
  try {
    await run('<create-thing>', async () => {
      const res = await fetch(`${app.base}/api/<route>`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ <real params> }),
      })
      expect(res.status === 201, `status ${res.status}`)
      const body = await res.json()
      expect(typeof body.id === 'string', 'response has no id')
      const back = await fetch(`${app.base}/api/<route>/${body.id}`)
      expect((await back.json()).<field> === <value>, 'stored value did not read back')
    })
  } finally { killTree(app.child) }
  finish()
}
```

## CLI flows

Run the real entry point from `package.json` `bin` (or the language's build
output) in a fresh temporary directory, so a flow cannot pass on leftovers.

```js
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ENTRY = path.resolve('<bin path from package.json>')
function cli(argv, cwd) {
  return spawnSync(process.execPath, [ENTRY, ...argv], { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
}

await run('<init-project>', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'verify-'))
  const r = cli(['<command>', '<args>'], cwd)
  expect(r.status === 0, `exit ${r.status}: ${(r.stderr || '').slice(0, 200)}`)
  expect(r.stdout.includes('<expected text>'), 'stdout missing expected text')
  expect(existsSync(path.join(cwd, '<file it writes>')), 'file not written')
  expect(readFileSync(path.join(cwd, '<file it writes>'), 'utf8').includes('<content>'), 'file content wrong')
})
finish()
```

## Project skill template

Write this to `<repo>/.claude/skills/<app>-verify/SKILL.md` and fill every
field from what the driver actually does.

```markdown
---
name: <app>-verify
description: "Drive <app> through its main user flows with the project driver and report pass or fail with evidence. Use after any change to <app>'s source and before claiming a change works."
allowed-tools: Bash, Read, Edit
---

# <app> verify

## Run

    node .claude/skills/<app>-verify/driver.mjs            all flows
    node .claude/skills/<app>-verify/driver.mjs --flow X   one flow
    node .claude/skills/<app>-verify/driver.mjs --base URL reuse a running server

Exit 0: every flow passed. Exit 1: a flow failed, its FAIL line names it.
Exit 2: could not run, the line says why. Exit 2 is never a pass.
Evidence: the directory printed on the last line (ignored by git).

## How the app starts

- Command: `<start command>`
- Readiness: `<URL returning 200, or log line>`
- Needs: `<variable names from .env.example>`

## Flows

| Flow | Steps | Asserts | Owned by |
|---|---|---|---|
| <name> | <steps> | <observable> | <source file> |

## When a flow changes

1. Edit that flow in `driver.mjs` to match the new behaviour.
2. Run it green: `--flow <name>`.
3. Plant a break in the file that owns the flow (rename the control, change the
   route), run it red, then undo with the inverse edit and run it green.
4. Update the table above and the line below.

## Last red proof

<date>: <plant> made `<flow>` fail, undo returned it to green.
```
