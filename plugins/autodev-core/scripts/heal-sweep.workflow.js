export const meta = {
  name: 'heal-sweep',
  description: 'Find, prove and fix vulnerabilities reachable from outside, across every repo you point it at',
  whenToUse: 'A periodic security sweep over several repos at once. Invoked by the `heal` skill.',
  phases: [
    { title: 'Surface', detail: 'enumerate what is actually reachable from the internet, then find vulns on it' },
    { title: 'Verify', detail: 'adversarial: prove an unauthenticated attacker reaches it, or kill the finding' },
    { title: 'Fix', detail: 'apply confirmed fixes in an isolated worktree, mutation-tested, commit only' },
  ],
}

// The shared bug-class registry. A tilde path, deliberately: agents resolve it in
// their own shell, so this file carries no absolute user-home path — which is
// itself one of the classes the registry lists.
const REGISTRY = (args && args.registry) || '~/claude-memory/BUG-CLASSES.md'

// Repos come from `args`, never hardcoded. Each entry:
//   { name, path, surface, gate }
// `surface` is the one that decides output quality — it tells the agent what
// "reachable from outside" MEANS for this repo. A published CLI and a Vercel app
// have completely different external surfaces, and an agent given no steer will
// look for HTTP routes in a repo that has none.
// `gate` is the repo's own verification command, e.g. 'npm run preflight'.
const REPOS = Array.isArray(args) ? args : (args && args.repos) || []

if (REPOS.length === 0) {
  throw new Error(
    'heal-sweep needs repos. Pass args as [{name, path, surface, gate}, ...]. ' +
    'Refusing to guess: a sweep that silently scanned nothing reports clean, ' +
    'and a clean report nobody asked for is worse than an error.'
  )
}

const missing = REPOS.filter(r => !r || !r.name || !r.path || !r.surface)
if (missing.length > 0) {
  throw new Error(
    `${missing.length} of ${REPOS.length} repo entries lack name, path or surface. ` +
    '`surface` is required, not optional — without it the agent invents an attack ' +
    'surface that does not exist.'
  )
}

log(`Sweeping ${REPOS.length} repo(s) for externally reachable vulnerabilities: ${REPOS.map(r => r.name).join(', ')}`)

const RULES = `
HARD RULES — these decide whether your output is usable at all:

SCOPE. Only vulnerabilities REACHABLE FROM OUTSIDE count. That is the explicit
instruction and it is the whole filter. In scope: anything an unauthenticated or
merely-authenticated-as-someone-else attacker on the internet can trigger. Out of
scope, and do NOT report: code style, internal refactors, absolute paths in local
tooling, test quality, gate integrity, dead code, anything requiring the attacker to
already have a developer's machine or a service-role key.

THE REACHABILITY TEST, applied to every candidate before you report it: write the
literal request. Method, path, headers, body, and what the attacker gets back. If you
cannot write that request, it is not an external vulnerability and it does not go in
the report. "An attacker could theoretically" is not a finding.

PUBLIC-BY-DESIGN IS NOT A LEAK. VITE_, NEXT_PUBLIC_ and PUBLIC_ prefixed values ship
to the browser deliberately. Supabase anon and publishable keys are identifiers, not
secrets — they are MEANT to be public and are protected by RLS. Firebase web API keys
likewise. Reporting one of these burns the report's credibility. What IS a finding is
a service-role key, a private API key, or an anon key protecting a table with RLS
disabled or a policy that evaluates to true.

PRINT THE POPULATION. "38 route files under api/, 214 exported handlers, 9 without an
auth check" can be judged. "Clean" cannot be told apart from a probe that ran on
nothing. Every status line carries a denominator.

VALIDATE ZEROS. Before reporting "none found", run your probe against something you
can see matches. If the known positive also returns empty, your probe is broken and
the answer is COULD_NOT_CHECK, not clean.

WINDOWS / GIT BASH. Prefer rg. grep exits 1 on no-match, so never chain a counting
grep with &&. Long inline node -e is blocked by a hook — write a file if you need one.

NEVER PRINT A LIVE SECRET. Report the key NAME, its length, and where it lives. Never
the value, not even partially, and not in a subagent transcript.
`

const FIND_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string' },
    attackSurface: {
      type: 'string',
      description: 'The enumerated external surface with counts: how many routes/functions/pages/tables, and which are unauthenticated. This is the denominator for everything else.',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          category: { type: 'string', description: 'e.g. authz-bypass, idor, ssrf, open-redirect, injection, rate-limit-bypass, rls-gap, webhook-unverified, cors, secret-exposure, dependency-cve' },
          file: { type: 'string' },
          line: { type: 'number' },
          evidence: { type: 'string', description: 'The actual code you read. Quote it.' },
          attackerRequest: { type: 'string', description: 'The literal request: method, path, headers, body. And what comes back. Mandatory — no request, no finding.' },
          impact: { type: 'string', description: 'What the attacker gains. Be concrete: which rows, whose data, what action.' },
          authRequired: { type: 'string', enum: ['none', 'any-logged-in-user', 'other-user-only'], description: 'What the attacker needs. "none" is the worst.' },
          proposedFix: { type: 'string' },
        },
        required: ['title', 'severity', 'category', 'file', 'evidence', 'attackerRequest', 'impact', 'authRequired', 'proposedFix'],
      },
    },
    checkedAndClean: { type: 'array', items: { type: 'string' }, description: 'Categories you actively checked that came back clean, each with its population and the known positive you validated against.' },
    couldNotCheck: { type: 'array', items: { type: 'string' }, description: 'What you could not establish and why. Never leave this empty without justification — a static read cannot see runtime, live RLS policies, or deployed config.' },
  },
  required: ['repo', 'attackSurface', 'findings', 'checkedAndClean', 'couldNotCheck'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          refuted: { type: 'boolean', description: 'true = NOT actually exploitable from outside. Default to true when uncertain.' },
          reason: { type: 'string', description: 'If refuted: what blocks it — a middleware, an RLS policy, a platform behaviour, a type guard. Name the file and line that stops it. If confirmed: the attacker path you re-walked yourself.' },
          severityAdjusted: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          fixIsSafe: { type: 'boolean', description: 'Is the proposed fix mechanical and safe to apply, or does it need a human judgement call per deployment?' },
          fixNotes: { type: 'string' },
        },
        required: ['title', 'file', 'refuted', 'reason', 'severityAdjusted', 'fixIsSafe'],
      },
    },
    missed: { type: 'array', items: { type: 'string' }, description: 'Anything the finder missed that you spotted while re-walking the surface. Reachable-from-outside only.' },
  },
  required: ['verdicts'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string' },
    branch: { type: 'string' },
    applied: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          change: { type: 'string', description: 'What you actually changed, concretely.' },
          mutationTest: { type: 'string', description: 'How you proved the fix works: the attacker request before (succeeded) and after (blocked), or the test you added and watched fail without the fix.' },
          verified: { type: 'boolean' },
        },
        required: ['title', 'file', 'change', 'mutationTest', 'verified'],
      },
    },
    skipped: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, why: { type: 'string' } }, required: ['title', 'why'] } },
    gateResult: { type: 'string', description: 'The exact command you ran (typecheck/build/test) and its real outcome. If it failed, say so with the output — never report a fix as done on a red gate.' },
    commits: { type: 'array', items: { type: 'string' } },
    couldNotVerify: { type: 'string' },
  },
  required: ['repo', 'applied', 'skipped', 'gateResult', 'couldNotVerify'],
}

const results = await pipeline(
  REPOS,

  // STAGE 1 — enumerate the surface, then find what is reachable on it
  (repo) => agent(
`You are auditing ONE repo for vulnerabilities REACHABLE FROM THE INTERNET.

REPO: ${repo.name}
PATH: ${repo.path}

WHAT ITS EXTERNAL SURFACE IS:
${repo.surface}

METHOD — do these in order, do not skip step 1:

1. ENUMERATE THE SURFACE BEFORE LOOKING FOR BUGS. List every externally reachable
   entry point and count them. Routes, serverless functions, edge functions, webhook
   receivers, auth callbacks, public pages, and every database table an anon key can
   touch. For each, record whether it checks authentication and authorisation. You
   cannot judge coverage without this list, and neither can I.

2. Read the shared bug-class registry and apply the classes that are externally
   reachable — 7 (header sniffing as a bypass), 1 (client IP from the leftmost
   x-forwarded-for, which makes every rate limit and every IP allow-list spoofable),
   and 6 (a workaround that upstream already fixed, where the workaround is now the
   hole):
     cat "${REGISTRY}"

3. Then sweep the standard external classes on the surface you enumerated:
   - missing or wrong AUTHORISATION: a handler that checks "is logged in" but not
     "owns this row". Test every id parameter for IDOR.
   - Supabase RLS gaps: a table reachable with the anon key whose policy is missing,
     disabled, or evaluates to true. Read the migrations. A view without
     security_invoker = true runs as its OWNER and bypasses the base table's RLS,
     which is worse than no view.
   - webhook receivers that do not verify a signature, or verify it after acting.
   - open redirect: a redirect target taken from a query parameter without an
     allow-list. Check OAuth callbacks specifically.
   - SSRF: a server-side fetch whose URL comes from user input.
   - injection: unparameterised SQL, and any shell command built by concatenation.
   - CORS: a wildcard origin combined with credentials.
   - secrets that actually ship to the client bundle — service-role keys, private API
     keys. Check what the build inlines, not just what is in .env.
   - rate limiting that can be bypassed, or is absent on an expensive or
     account-affecting endpoint (login, password reset, generation, payment).
   - dependency CVEs that are reachable from this surface. Report the version
     INSTALLED beside the version FIXED, and say whether the vulnerable path is
     actually called. An unreachable transitive dep is noise.

4. For every candidate, write the attacker's literal request before you report it.
   That is the filter that separates a finding from a grep hit.

${RULES}

READ-ONLY in this stage. Do not edit, commit, or switch branches — other live
sessions have uncommitted work in this clone. You are finding, not fixing.`,
    { label: `find:${repo.name}`, phase: 'Surface', schema: FIND_SCHEMA, model: 'opus', effort: 'high' }
  ),

  // STAGE 2 — adversarial reachability check
  (found, repo) => {
    if (!found || !found.findings || found.findings.length === 0) {
      return { verdicts: [], missed: [], _surface: found, _repo: repo }
    }
    return agent(
`You are the SKEPTIC. Your job is to REFUTE these findings, not to confirm them.

REPO: ${repo.name}
PATH: ${repo.path}

The finder enumerated this surface:
${found.attackSurface}

And claims these are reachable from outside:
${JSON.stringify(found.findings, null, 1).slice(0, 90000)}

For EACH one, go and look yourself. Do not take the finder's word for anything.

Try hard to refute it. Something usually blocks these: a middleware that runs before
the handler, an RLS policy the finder did not read, a platform behaviour that
overwrites the header, a framework default, a type guard, an auth check one layer up
the call chain. Find that thing and name it with a file and a line.

DEFAULT TO refuted = true WHEN YOU ARE UNSURE. A false positive shipped as a fix
means a change made to working code, which is strictly worse than the nothing a
missed finding produces. A detector at 33% precision gets muted, and then it misses
the real one.

Confirm ONLY when you have re-walked the attacker path yourself and it holds end to
end, unauthenticated or as the wrong user. Say which.

Then judge each surviving fix: is it mechanical and safe, or does it need a human
judgement call? Fixes that differ per deployment, and fixes that are a REMOVAL of an
existing safety measure, are NOT safe to automate — set fixIsSafe false and explain.

Finally: while you were re-walking the surface, did you spot anything the finder
MISSED? Externally reachable only. Same evidence bar.

${RULES}

READ-ONLY. You are judging, not fixing.`,
      { label: `verify:${repo.name}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: 'opus', effort: 'xhigh' }
    ).then(v => ({ ...v, _surface: found, _repo: repo }))
  },

  // STAGE 3 — fix the confirmed ones, isolated
  (verified, repo) => {
    const confirmed = (verified?.verdicts || []).filter(v => !v.refuted)
    const safe = confirmed.filter(v => v.fixIsSafe)
    if (safe.length === 0) {
      return {
        repo: repo.name,
        applied: [],
        skipped: confirmed.map(c => ({ title: c.title, why: 'confirmed but fixIsSafe=false — needs a human judgement call' })),
        gateResult: 'not run — nothing safe to apply',
        couldNotVerify: confirmed.length === 0
          ? 'No findings survived adversarial verification.'
          : `${confirmed.length} confirmed but none mechanically safe to auto-apply.`,
        _verified: verified,
      }
    }
    return agent(
`Fix CONFIRMED, externally reachable vulnerabilities in ${repo.name}.

PATH: ${repo.path}

These survived an adversarial reachability check and were judged mechanically safe:
${JSON.stringify(safe, null, 1).slice(0, 60000)}

Original findings with the attacker request and proposed fix for each:
${JSON.stringify((verified?._surface?.findings || []).filter(f => safe.some(s => s.title === f.title)), null, 1).slice(0, 60000)}

HOW TO WORK:

1. You are in your OWN git worktree. Other sessions are live in the main clone with
   uncommitted work — never touch it, never switch its branch.

2. SURGICAL. Touch only what the vulnerability requires. Do not improve adjacent code
   that is not broken, do not reformat, do not rename. A security fix reviewed
   alongside a refactor gets reviewed as neither.

3. Fix the CLASS, not the instance. If one handler takes the client IP from the
   leftmost x-forwarded-for entry, grep for every other call site doing the same and
   fix all of them, or name the ones you are leaving and why. One handler fixed while
   four siblings stay open is not a fix.

4. MUTATION-TEST EVERY FIX. This is the part that is usually skipped and it is the
   only thing that turns a claim into evidence. Show the attacker request being
   blocked AFTER the change, and confirm the same request succeeded BEFORE it. A test
   you never watched fail proves nothing. Write what you actually observed into
   mutationTest — if you could not run it, say so there rather than implying you did.

5. Run the repo's real gate afterwards and report its ACTUAL output:
     ${repo.gate || 'no gate command was supplied for this repo - find it in package.json (preflight, gate, check) and say which one you ran'}
   If the gate goes red, say so with the output. Never report a fix as done on a red
   gate; a broken build is a worse outcome than the vulnerability for a live product.

6. COMMIT in your worktree, conventional format, body explaining WHY the fix is
   correct rather than what changed. DO NOT PUSH and do not open a PR — pushing needs
   Andy's explicit yes in the turn, and these repos deploy on push.

7. If a fix turns out NOT to be safe once you are inside the code, STOP and put it in
   skipped with the reason. Reporting "this is riskier than it looked" is a better
   outcome than a compliant change that breaks a paying product.

${RULES}`,
      { label: `fix:${repo.name}`, phase: 'Fix', schema: FIX_SCHEMA, isolation: 'worktree', model: 'opus', effort: 'high' }
    ).then(f => ({ ...f, _verified: verified }))
  }
)

const clean = results.filter(Boolean)
log(`Done. ${clean.length}/3 repos completed the find -> verify -> fix pipeline.`)

return {
  perRepo: clean.map(r => ({
    repo: r.repo,
    applied: r.applied,
    skipped: r.skipped,
    gateResult: r.gateResult,
    commits: r.commits,
    couldNotVerify: r.couldNotVerify,
    surface: r._verified?._surface?.attackSurface,
    checkedAndClean: r._verified?._surface?.checkedAndClean,
    couldNotCheck: r._verified?._surface?.couldNotCheck,
    refuted: (r._verified?.verdicts || []).filter(v => v.refuted).map(v => ({ title: v.title, reason: v.reason })),
    confirmed: (r._verified?.verdicts || []).filter(v => !v.refuted).map(v => ({ title: v.title, severity: v.severityAdjusted, fixIsSafe: v.fixIsSafe, reason: v.reason })),
    missedByFinder: r._verified?.missed,
  })),
}
