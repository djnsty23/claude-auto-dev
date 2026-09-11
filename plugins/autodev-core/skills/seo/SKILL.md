---
name: seo
description: SEO audit — verify metadata, structured data, and crawlability against a pre-launch checklist, and validate the JSON-LD actually parses.
when_to_use: "Invoked when the user says \"seo\", \"meta tags\", \"open graph\", \"structured data\", \"json-ld\", \"sitemap\", or asks why pages are not ranking or previewing correctly."
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
- [ ] Core Web Vitals inside budget (see the `perf` skill)
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

## 4. Report

Group findings as Critical (blocks indexing), High (blocks rich results),
Medium (weakens ranking), Low (polish). Give `file:line` and the corrected
markup for each. State the scanned URL population, build identity, raw/
hydrated checks, intentional exclusions and unresolved validation gaps. A clean
metadata scan cannot guarantee indexing, rich results or rankings.
