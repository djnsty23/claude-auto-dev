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

```bash
curl -s http://localhost:3000 | grep -iE '<title>|og:|twitter:|canonical|application/ld\+json'
curl -s http://localhost:3000/sitemap.xml | head -20
curl -s http://localhost:3000/robots.txt
```

For client-rendered routes, use the `browser` skill and read the DOM after
hydration — `curl` will not see it, and neither will some crawlers, which is
itself the finding.

## 2. Pre-launch checklist

- [ ] Unique `<title>` per page, 50–60 chars
- [ ] Meta description per page, 150–160 chars
- [ ] Exactly one `<h1>` per page
- [ ] Open Graph + Twitter tags on every shareable page, with an image that resolves
- [ ] JSON-LD on key pages (Organization, Product, Article) — and it **parses**
- [ ] `sitemap.xml` generated, current, and submitted
- [ ] `robots.txt` does not block anything important
- [ ] Canonical tag on every page, absolute URL
- [ ] Alt text on all images
- [ ] Internal links between related pages
- [ ] Core Web Vitals inside budget (see the `perf` skill)
- [ ] HTTPS everywhere, mobile-responsive

**E-commerce, if applicable:** Product schema on product pages, BreadcrumbList
for navigation, unique copy on category pages, out-of-stock pages that return
200 rather than 404, and faceted navigation that does not mint duplicate URLs.

## 3. Validate structured data

Never hand-write JSON-LD and call it done — malformed schema fails silently in
search results.

```bash
curl -s http://localhost:3000 | sed -n 's/.*<script type="application\/ld+json">\(.*\)<\/script>.*/\1/p' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(d),null,2))}catch(e){console.error("INVALID JSON-LD:",e.message);process.exit(1)}})'
```

Then point the user at the [Rich Results Test](https://search.google.com/test/rich-results)
and [Schema Validator](https://validator.schema.org/) for the authoritative check.

## 4. Report

Group findings as Critical (blocks indexing), High (blocks rich results),
Medium (weakens ranking), Low (polish). Give `file:line` and the corrected
markup for each.
