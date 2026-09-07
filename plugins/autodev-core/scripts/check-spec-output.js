#!/usr/bin/env node
// Validates what the `spec` skill produced, before anyone builds on it.
//
// A planning skill's failure mode is not crashing — it is emitting confident
// filler. "Auth flow", "Dashboard layout", "Set up the database": each looks
// like a plan, none says what the thing does, and the cost only appears later
// when `auto` works through stories nobody can tell are finished. Every rule
// here exists to make that specific failure loud at generation time.
//
// A SECOND FAILURE, added 2026-09-08: a plan that names an external service and
// plans no human step for it. `[measured 2026-09-07]` a greenfield run's
// SPEC.md said "Supabase holds the members ... Vercel serves the page" and its
// prd.json had zero stories about either. This check passed it. `auto` then hit
// the missing project on its first story, hand-edited `passes: "needs-setup"`
// into prd.json, and wrote the handback into a log file. With `--spec SPEC.md`
// the same plan fails here, at generation time, naming the two services.
//
// HOW THE SPEC RULE IS SHAPED, and why the lexicon below is not the verdict.
// `[measured 2026-09-08]` the lexicon run over that SPEC.md and eight README /
// CLAUDE.md files hit 49 times; read one by one, 35 were services the product
// actually integrates and 14 were mentions — "no Google OAuth", "Slack-style
// preview", "refs purged", "considered later". A gate that FAILED on every
// mention would be wrong one time in three and would be learned around. So:
//
//   - SPEC.md carries a `## External services` section, written by `spec`,
//     listing each service that needs an account, a key, a domain or a payment
//     method — or the single word "none". THAT LIST is the verdict: every item
//     must have a setup story that names it.
//   - The lexicon guards the one failure the list cannot: the section missing
//     altogether while the prose names services. That is the greenfield case,
//     and it fails with the candidates listed for the author to confirm.
//   - A lexicon hit outside the section, when the section exists, is a NOTE.
//     The author saw the section and did not list it; the gate says so once.
//
// Usage: node check-spec-output.js [prd.json] [schema.sql] [--spec SPEC.md]
// Exit 1 on any violation.

const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, 'prd-states.js'));

// Titles that describe a LAYER instead of a capability. A plan made of these
// would fit any product ever specified, which is what makes it worthless.
const GENERIC = [
  /^(set ?up|setup|configure|initialise|initialize|scaffold|create|add|build|implement)\s+(the\s+)?(project|app|database|db|schema|backend|frontend|ui|api|auth|authentication|login|dashboard|layout|components?|tests?|ci|deployment)\.?$/i,
  /^(auth|authentication|login|signup) flow$/i,
  /^(dashboard|admin|settings|profile|landing)( page| layout| screen)?$/i,
  /^(error handling|state management|routing|styling|polish|cleanup|refactor)$/i,
  /^(mvp|v1|phase \d+|milestone \d+)/i,
];

// `setup` is the type of a story whose whole content is a human act: create the
// account, buy the domain, flip the console toggle. It is born `needs-setup`
// and is the only type allowed to be.
const TYPES = new Set(['fix', 'feature', 'refactor', 'qa', 'perf', 'setup']);

// External services a SPEC.md can name, each of which implies an account, a key,
// a domain, a payment method or an approval that no agent can produce.
//
// DELIBERATELY UNAMBIGUOUS NAMES ONLY. "render", "segment", "neon" and "resend"
// are English words and were left out; a false positive here fails a spec that
// planned nothing wrong, and a gate that cries wolf is one people learn to
// skip. Each entry is a word-boundary regex, case-insensitive. Measured against
// one real SPEC.md and four repos' README/CLAUDE.md before shipping — see
// docs/evidence-needs-setup-2026-09-08.md for the hit list and what each was.
const SERVICES = [
  ['Supabase', /\bsupabase\b/i],
  ['Vercel', /\bvercel\b/i],
  ['Netlify', /\bnetlify\b/i],
  ['Cloudflare', /\bcloudflare\b/i],
  ['Firebase', /\bfirebase\b/i],
  ['Stripe', /\bstripe\b/i],
  ['Paddle', /\bpaddle\b/i],
  ['Lemon Squeezy', /\blemon ?squeezy\b/i],
  ['PayPal', /\bpaypal\b/i],
  ['SendGrid', /\bsendgrid\b/i],
  ['Postmark', /\bpostmark\b/i],
  ['Mailgun', /\bmailgun\b/i],
  ['Twilio', /\btwilio\b/i],
  ['OpenAI', /\bopenai\b/i],
  ['Anthropic', /\banthropic\b/i],
  ['Gemini', /\bgemini\b/i],
  ['Clerk', /\bclerk\b/i],
  ['Auth0', /\bauth0\b/i],
  ['Google OAuth', /\bgoogle (oauth|sign[- ]?in|login)\b/i],
  ['Sign in with Apple', /\b(sign[- ]?in with apple|apple sign[- ]?in)\b/i],
  ['GitHub OAuth', /\bgithub (oauth|sign[- ]?in|login|app)\b/i],
  ['App Store', /\bapp store\b/i],
  ['Play Store', /\b(play store|google play)\b/i],
  ['TestFlight', /\btestflight\b/i],
  ['Sentry', /\bsentry\b/i],
  ['PostHog', /\bposthog\b/i],
  ['Plausible', /\bplausible\.io\b|\bplausible analytics\b/i],
  ['Mixpanel', /\bmixpanel\b/i],
  ['Google Analytics', /\bgoogle analytics\b|\bga4\b/i],
  ['Doppler', /\bdoppler\b/i],
  ['Upstash', /\bupstash\b/i],
  ['PlanetScale', /\bplanetscale\b/i],
  ['Railway', /\brailway\b/i],
  ['Fly.io', /\bfly\.io\b/i],
  ['Heroku', /\bheroku\b/i],
  ['AWS', /\baws\b|\bamazon web services\b/i],
  ['Algolia', /\balgolia\b/i],
  ['Pinecone', /\bpinecone\b/i],
  ['Spotify API', /\bspotify (api|developer|oauth)\b/i],
  ['HubSpot', /\bhubspot\b/i],
  ['Slack', /\bslack\b/i],
  ['Discord', /\bdiscord\b/i],
  ['Mapbox', /\bmapbox\b/i],
  ['Google Maps', /\bgoogle maps\b/i],
  ['Expo EAS', /\bexpo\b|\beas build\b/i],
  ['custom domain', /\bcustom domain\b|\bdns\b|\bregistrar\b/i],
];

/** The body of the first heading matching `re`, up to the next heading. */
function sectionBody(text, re) {
  const m = new RegExp('^(#{1,6})\\s*' + re + '[^\\n]*\\n([\\s\\S]*?)(?=^#{1,6}\\s|(?![\\s\\S]))', 'im').exec(text);
  return m ? { body: m[2], index: m.index, length: m[0].length } : null;
}

/**
 * What a SPEC.md says about external services, in three parts:
 *
 *   declared  the items under `## External services` (empty if it says "none")
 *   hasSection  whether that section exists at all
 *   candidates  lexicon hits in the prose OUTSIDE Non-goals and OUTSIDE the
 *               section itself — what the author may have forgotten to list
 *   excused   lexicon hits found only under Non-goals: a service the spec
 *             decided against ("Posting to Slack (webhook or bot)")
 *
 * A declared item is one bullet line. Its NAME is the text before the first
 * " — ", " - ", ":" or "(", so
 *   "- Supabase — a project, its URL and anon key (https://supabase.com/dashboard)"
 * declares "Supabase".
 */
function findServices(specText) {
  const text = String(specText || '');
  const ng = sectionBody(text, 'non[- ]goals?\\b');
  const sec = sectionBody(text, 'external services?\\b');
  const cut = (t, part) => (part ? t.slice(0, part.index) + t.slice(part.index + part.length) : t);
  let rest = cut(text, sec);
  // Recompute Non-goals on the text with the section removed, so offsets hold.
  const ng2 = sectionBody(rest, 'non[- ]goals?\\b');
  rest = cut(rest, ng2);
  const nonGoals = ng ? ng.body : '';

  const declared = [];
  if (sec) {
    for (const line of sec.body.split('\n')) {
      const m = /^\s*[-*+]\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const name = m[1].split(/\s+[—–-]\s+|:|\(/)[0].replace(/[*_`]/g, '').trim();
      if (name && !/^none\b/i.test(name)) declared.push(name);
    }
  }
  const candidates = [];
  const excused = [];
  for (const [name, re] of SERVICES) {
    // "Slack-style", "Stripe-like": a comparison, not an integration.
    const rest2 = rest.replace(new RegExp(re.source + '-(style|like|ish)\\b', 'gi'), '');
    if (re.test(rest2)) {
      if (!declared.some((d) => re.test(d))) candidates.push(name);
    } else if (re.test(nonGoals)) excused.push(name);
  }
  return { hasSection: !!sec, declared, candidates, excused };
}

function run(prdPath, sqlPath, specPath) {
  const problems = [];
  const note = (id, msg) => problems.push(`${id}: ${msg}`);
  const out = [];

  if (!fs.existsSync(prdPath)) { console.error(`check-spec-output: no ${prdPath}`); return 1; }

  let prd;
  try { prd = JSON.parse(fs.readFileSync(prdPath, 'utf8')); }
  catch (e) { console.error(`check-spec-output: ${prdPath} does not parse — ${e.message}`); return 1; }

  // Stories may sit at the root or inside a sprint. This file had the only
  // correct version of that read; it is now the SHARED one, so there is a single
  // opinion rather than six private ones.
  //
  // One behaviour change, deliberate: this took the newest sprint only, and
  // storiesOf() takes every sprint. On a fresh spec — the thing this gate exists
  // to check — there is one sprint and the two are identical. On a multi-sprint
  // file it now also validates earlier sprints, which is what makes an id
  // duplicated ACROSS sprints visible; that was previously unreachable here.
  const stories = S.storiesOf(prd);
  const entries = Object.entries(stories);

  if (!entries.length) { console.error('check-spec-output: zero stories — a spec that plans nothing is not a spec'); return 1; }

  const seen = new Set();
  const setupStories = [];

  for (const [key, s] of entries) {
    const id = s.id || key;
    if (!/^S\d+-\d{3}$/.test(id)) note(id, `id does not match S{sprint}-{nnn}`);
    if (seen.has(id)) note(id, 'duplicate id');
    seen.add(id);
    if (key !== id) note(key, `object key "${key}" disagrees with the story's own id "${id}"`);

    const title = (s.title || '').trim();
    if (!title) note(id, 'no title');
    else {
      if (GENERIC.some((re) => re.test(title))) note(id, `"${title}" names a layer, not a capability — say what it lets someone do`);
      if (title.split(/\s+/).length < 3) note(id, `"${title}" is too short to be a capability`);
    }

    // passes must be null — a freshly planned story cannot already be done, and
    // `false`/`"deferred"` are decisions nobody has made yet — EXCEPT a setup
    // story, which is born blocked on a person and says so. The two are tied:
    // a needs-setup story that is not type setup is a planned story pretending
    // to be blocked, and a setup story that is null is a human act an agent
    // would pick up and fail at.
    const isSetup = s.type === 'setup';
    if (isSetup) {
      setupStories.push([id, s]);
      if (s.passes !== S.NEEDS_SETUP) note(id, `type is "setup" but passes is ${JSON.stringify(s.passes)}; a setup story is born "needs-setup"`);
      const reason = String(s.blockedReason || '').trim();
      if (!reason) note(id, 'a setup story needs blockedReason: what is needed and the exact console URL or path');
      else if (!/https?:\/\/\S+/.test(reason)) note(id, `blockedReason has no URL — say exactly where the person goes (got: "${reason.slice(0, 60)}")`);
    } else if (s.passes !== null) {
      note(id, `passes is ${JSON.stringify(s.passes)}; a newly planned story must be null`
        + (s.passes === S.NEEDS_SETUP ? ' (or type "setup" if this is a human step)' : ''));
    }
    if (!TYPES.has(s.type)) note(id, `type ${JSON.stringify(s.type)} is not one of ${[...TYPES].join(', ')}`);
    if (!Number.isInteger(s.priority) || s.priority < 0 || s.priority > 3) note(id, `priority ${JSON.stringify(s.priority)} is not 0-3`);

    // A dependency must name a story that exists. blockedBy is read by auto's
    // selector and by prd-states.isReady(); a typo there blocks a story forever
    // with nothing saying why.
    if (s.blockedBy !== undefined) {
      if (!Array.isArray(s.blockedBy)) note(id, 'blockedBy must be an array of story ids');
      else for (const dep of s.blockedBy) {
        if (!(dep in stories)) note(id, `blockedBy names "${dep}", which is not a story in this file`);
        if (dep === id) note(id, 'blockedBy names itself');
      }
    }

    // The acceptance criterion lives in `notes` — the core schema has no dedicated
    // field and inventing one would drift from every other reader of prd.json.
    const notes = (s.notes || '').trim();
    if (!notes) note(id, 'no acceptance criterion in notes');
    else if (notes.split(/\s+/).length < 6) note(id, `acceptance criterion is ${notes.split(/\s+/).length} words; too short to check against`);
    else {
      // Deliberately a DENYLIST of vagueness, not an allowlist of good verbs.
      // The first version of this check required a verb from a list —
      // shows/returns/rejects/persists — and immediately rejected its own
      // reference example, whose criterion said "inserts a check-in" and "the
      // count increments". The set of verbs describing an observable outcome is
      // open; the set of words used to avoid describing one is small and closed.
      const VAGUE = /\b(works?|correctly|properly|as expected|appropriately|nice|intuitive|seamless|smooth|robust|user[- ]friendly|good|better|improved|handled|functional|successfully)\b/i;
      const hit = VAGUE.exec(notes);
      if (hit) note(id, `acceptance criterion leans on "${hit[1]}" — say what is observably true instead`);
    }
  }

  // The SPEC's own `## External services` list is the verdict: every declared
  // item needs a setup story that names it back, in its title, notes or
  // blockedReason — so "Create the Supabase project" covers a spec that
  // declares "Supabase". The lexicon only catches the section being absent.
  let services = null;
  if (specPath) {
    if (!fs.existsSync(specPath)) { console.error(`check-spec-output: no ${specPath}`); return 1; }
    services = findServices(fs.readFileSync(specPath, 'utf8'));
    const haystack = setupStories.map(([, s]) => `${s.title || ''}\n${s.notes || ''}\n${s.blockedReason || ''}`);
    const mentions = (name) => {
      const known = SERVICES.find(([n]) => n.toLowerCase() === name.toLowerCase());
      const re = known ? known[1] : new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      return haystack.some((h) => re.test(h));
    };
    if (!services.hasSection) {
      if (services.candidates.length) {
        note('spec', `${path.basename(specPath)} has no "## External services" section and names ${services.candidates.join(', ')} — list each one that needs an account, a key, a domain or a payment method (or write "none"), and give each a setup story`);
      } else {
        note('spec', `${path.basename(specPath)} has no "## External services" section — add it, even if it says "none"`);
      }
    } else {
      for (const name of services.declared) {
        if (!mentions(name)) {
          note('spec', `${path.basename(specPath)} declares ${name} under External services and no setup story (type "setup", passes "needs-setup") mentions it — who creates the account, and where?`);
        }
      }
      for (const name of services.candidates) {
        out.push(`note: ${path.basename(specPath)} also names ${name} outside External services; if it needs an account, declare it there`);
      }
    }
    // A setup story with no dependents is legal (a legal page, a store listing)
    // but worth a line: a human step nothing waits on is easy to forget.
    for (const [id] of setupStories) {
      const dependents = entries.filter(([, s]) => Array.isArray(s.blockedBy) && s.blockedBy.includes(id)).length;
      if (!dependents) out.push(`note: setup story ${id} has no dependents — nothing is blockedBy it, so make sure that is true`);
    }
  }

  // Schema: every table must have RLS turned on. Deny-by-default is the house
  // rule, and a table created without it is open to every authenticated user.
  let tables = 0, rlsOn = 0;
  if (sqlPath && fs.existsSync(sqlPath)) {
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const created = [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?(?:public\.)?([a-z0-9_]+)/gi)].map((m) => m[1]);
    tables = created.length;
    for (const t of created) {
      const re = new RegExp(`alter\\s+table\\s+["\`]?(?:public\\.)?${t}["\`]?\\s+enable\\s+row\\s+level\\s+security`, 'i');
      if (re.test(sql)) rlsOn++;
      else note(t, 'table created without "enable row level security"');
    }
    if (tables && !/create\s+policy/i.test(sql)) note('schema', 'RLS is enabled but no policy is defined — that denies everyone, including the app');
  }

  // Print the population, so "no problems" is distinguishable from "read nothing".
  console.log(`check-spec-output: ${entries.length} stories in ${path.basename(prdPath)}`
    + (setupStories.length ? ` (${setupStories.length} setup, blocked on you)` : '')
    + (sqlPath ? `, ${tables} tables in ${path.basename(sqlPath)} (${rlsOn} with RLS)` : ', no schema given')
    + (services
      ? `, ${path.basename(specPath)} declares ${services.declared.length} external service(s)`
        + (services.declared.length ? ` (${services.declared.join(', ')})` : '')
        + (!services.hasSection ? ' [no External services section]' : '')
        + (services.candidates.length ? `, prose also names ${services.candidates.join(', ')}` : '')
        + (services.excused.length ? `, under Non-goals: ${services.excused.join(', ')}` : '')
      : ', no SPEC.md given'));
  for (const l of out) console.log(l);

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error('  ' + p);
    return 1;
  }
  console.log('all stories are specific, checkable and pending' + (tables ? '; every table has RLS' : '')
    + (services ? '; every declared external service has a setup story' : ''));
  return 0;
}

function main(argv) {
  const specIdx = argv.indexOf('--spec');
  const specPath = specIdx >= 0 ? argv[specIdx + 1] || null : null;
  // Drop the flag and its value; with no flag, specIdx is -1 and nothing is
  // dropped (an earlier draft compared i !== specIdx + 1 unconditionally and
  // ate the first positional, which the suite's positive control caught).
  const positional = argv.filter((a, i) => !(specIdx >= 0 && (i === specIdx || i === specIdx + 1)));
  return run(positional[0] || 'prd.json', positional[1] || null, specPath);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { SERVICES, findServices, run };
