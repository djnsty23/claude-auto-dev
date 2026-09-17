---
name: seo
description: "Audit a page or a site for search and AI-answer visibility: metadata and Open Graph tags in the SERVED html, JSON-LD that actually parses, canonical, sitemap and robots correctness, and which AI crawlers are allowed to read or to cite the site."
when_to_use: "Use when asked to look at robots.txt, meta or OG tags, JSON-LD or structured data, a sitemap, hreflang or llms.txt. Use when asked whether ChatGPT, Claude or Google AI can find, read or cite a site, when a page is not ranking, not indexed or not previewing correctly, and on the words seo, geo, aeo or ai search."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[url or page path]"
---

# SEO Audit

You know the Next.js Metadata API and schema.org. This skill is the checklist
and the verification step — the part that is easy to skip and the reason SEO
work silently fails.

## 1. Inspect what actually renders

Metadata that exists in source but not in the served HTML is worth nothing.
Check the rendered output, not the component:

Identify the intended public URL and the revision/deployment it serves. Capture
the document, sitemap and robots responses with their status and redirect chain;
retain failures and complete output. For example, after creating the report
directory and setting the confirmed `TARGET_URL`:

```bash
curl --fail-with-body --show-error --location --dump-header .claude/reports/seo-headers.txt --output .claude/reports/seo.html "$TARGET_URL"
```

Inspect all expected metadata in that document. Use the available browser driver
to inspect the hydrated DOM too when relevant. Record which representation each
crawler consumes: hydrated metadata alone does not prove a social preview bot
can see it. A missing/failing fetch is a gap, not an empty clean scan.

## 2. Pre-launch checklist

- [ ] Descriptive, distinct titles and useful page-specific descriptions
- [ ] Heading hierarchy matches the page content
- [ ] Open Graph + Twitter tags on every shareable page, with an image that resolves
- [ ] JSON-LD on key pages (Organization, Product, Article) — and it **parses**
- [ ] Sitemap lists intended canonical indexable URLs and resolves; verify submission status when within the task scope
- [ ] Robots and indexing directives match intended public/private page policy
- [ ] Canonical tag on every page, absolute URL
- [ ] Meaningful image alternatives; decorative images use empty alt text
- [ ] Internal links between related pages
- [ ] Core Web Vitals inside budget (see the `perf` skill). Responsiveness is INP,
      which replaced FID in 2024, so a budget naming FID is measuring a retired metric
- [ ] AI crawler access matches the intent, checked per crawler (section 4)
- [ ] HTTPS everywhere, mobile-responsive

**E-commerce, if applicable:** Product schema on product pages, BreadcrumbList
for navigation, unique copy on category pages, out-of-stock pages that return
200 rather than 404, and faceted navigation that does not mint duplicate URLs.

## 3. Validate structured data

Parse every JSON-LD script in the actual response/DOM, including multiline and
multiple blocks. Do not extract HTML with a single-line greedy regex. In the
available browser’s JavaScript evaluation tool:

```javascript
Array.from(document.querySelectorAll('script[type="application/ld+json"]'), (el, index) => {
  try { return { index, value: JSON.parse(el.textContent) }; }
  catch (error) { return { index, error: error.message }; }
});
```

Record the block count and all parse errors. Zero blocks is a failure only where
structured data is expected; valid JSON alone does not prove schema semantics
or rich-result eligibility. Check that values match visible content, and run
the [Rich Results Test](https://search.google.com/test/rich-results) and
[Schema Validator](https://validator.schema.org/) when applicable and available.
If validation cannot run, name the gap and continue checks that can.

Title and description lengths are editorial guidance, not fixed Google limits;
Google may truncate or select different text. See
[title links](https://developers.google.com/search/docs/appearance/title-link) and
[snippets](https://developers.google.com/search/docs/appearance/snippet).

A schema type that earns no rich result is not a finding. `[verified 2026-09-17]`
Google's FAQPage page records the removal of that documentation because the FAQ
rich result is no longer shown in Search, per its May 2026 changelog entry. So
missing or removed `FAQPage` markup is not a lost rich result, and recommending it
as one sends the client work that buys nothing. Check the current
[search gallery](https://developers.google.com/search/docs/appearance/structured-data/search-gallery)
before promising any rich result, rather than quoting a type from memory.

## 4. AI crawler access, checked per crawler

Each vendor runs SEPARATE crawlers for training and for the answers users see, and
one robots.txt rule can allow the first while blocking the second. Allowing
`GPTBot` and `ClaudeBot` while blocking `OAI-SearchBot` and `Claude-SearchBot` is
the common version of this, and it is backwards for most sites: it donates the
content to training and declines the citation. Read each rule against the claim the
site actually wants to make. `[verified 2026-09-17]` from the vendor docs linked below.

| Product token | Vendor and job | Blocking it costs |
|---|---|---|
| `GPTBot` | OpenAI, model training | nothing in ChatGPT search results |
| `OAI-SearchBot` | OpenAI, ChatGPT search results | appearing and being cited in ChatGPT |
| `ChatGPT-User` | OpenAI, user-triggered fetch | pages a user asks ChatGPT to open |
| `OAI-AdsBot` | OpenAI, ad safety validation | running ads on ChatGPT |
| `ClaudeBot` | Anthropic, model training | nothing in Claude's search results |
| `Claude-SearchBot` | Anthropic, search result quality | being cited in Claude's answers |
| `Claude-User` | Anthropic, user-triggered fetch | pages a user asks Claude to open |
| `Google-Extended` | Google, Gemini training and grounding | nothing in Search: Google states it neither affects inclusion nor acts as a ranking signal |
| `Googlebot` | Google Search, and the AI features built on that index | Search, and with it Google's AI answers |

Sources: [OpenAI bots](https://developers.openai.com/api/docs/bots),
[Anthropic crawlers](https://privacy.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler),
[Google crawlers](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers).
These lists change, so read the vendor page before writing a rule, and do not carry
a retired token such as `anthropic-ai` into a robots.txt from an old blog post.

Two further limits worth stating to a client who asks for "AI SEO":

- `llms.txt` is optional. `[verified 2026-09-17]` Google's
  [AI features guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)
  says no machine-readable AI files, markup or Markdown are needed to appear in
  Google Search, and that it ignores them. Ship one if the client wants it, and never
  report its absence above Low.
- A page that renders its content only in JavaScript is a bigger AI-visibility risk
  than any of the above, because the user-triggered fetchers generally do not run it.
  Test with JavaScript disabled, not just with the hydrated DOM.

## 5. Evidence from Search Console, when a connector is available

A crawl tells you what the page says. Only Search Console tells you what Google did
with it. If a Search Console MCP server or the API is connected, use it, and say in
the report that you did:

- **Indexing truth.** URL Inspection reports the crawl status, the canonical Google
  chose and the reason for an exclusion. A 200 from `curl` proves none of that.
- **Striking distance.** Queries with impressions at average position roughly 8 to 20
  are the cheapest wins on most sites, because the page already ranks. Name the query,
  the page and the current position, not a generic "improve the title".
- **Decay.** Compare the last 28 days against the previous 28 and list pages losing
  impressions. That separates a ranking loss from a page nobody ever saw.
- **Totals never equal the sum of the rows.** Search Console drops anonymised queries,
  so summing query rows understates the property total. Report the two separately and
  never present a row sum as the site total.

Without a connector, say so in the report. An audit that never saw Search Console data
cannot rule out an indexing problem, and silence there reads as a clean result.

## 6. Report

Group findings as Critical (blocks indexing), High (blocks rich results),
Medium (weakens ranking), Low (polish). Give `file:line` and the corrected
markup for each. State the scanned URL population, build identity, raw/
hydrated checks, intentional exclusions and unresolved validation gaps. Name which
AI crawlers you checked and whether Search Console data was available, because both
are absences a reader will otherwise read as passes. A clean metadata scan cannot
guarantee indexing, rich results or rankings.
