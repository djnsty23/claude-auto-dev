# Marketing radar gap evidence, 2026-09-21

This records the 14-day radar run `2026-09-21T19-58-50-089Z-34228` and the bounded checks made while repairing the harness. The run found 118 items (115 feed items and three videos) across 50 configured sources. Forty-nine sources succeeded and Search Engine Land RSS failed with HTTP 403. Eighty-six items required review and clustered into 113 underlying claims. Three transcripts were collected; three bounded top/recent comment requests returned zero comments. No marketing hypothesis was executed and no business outcome was measured.

## Source recovery: no winner

| Arm | Observed population | Decision |
|---|---|---|
| A: Search Engine Land RSS and ordinary URL variants | Feed, trailing slash, RSS query, sitemap and WordPress API returned HTTP 403 | Keep the failure explicit |
| B: Google News RSS query restricted to the publisher and 14 days | HTTP 200, 98 in-window entries, zero directly extractable canonical publisher URLs | Insufficient provenance |
| C: Bing News RSS query restricted to the publisher | HTTP 200, 10 entries with extractable publisher URLs, freshest 2026-09-16; date-sorted variant had nine, freshest 2026-09-18 | Insufficient freshness |

Neither proxy is added to the source registry. A candidate needs direct publisher provenance, current coverage, and three-run stability and utility evidence before adoption. The dashboard now displays source failures, partial states and zero-yield sources so a healthy total cannot hide missing coverage.

## Comment filter: harness correctness only

The old rule excluded all creator replies, same-author repeats and several ordinary discussions. On 18 labeled synthetic comments, the prior rule classified 10 of the original 17 cases correctly; the selected narrow rule classified all 18 current cases correctly. A simpler narrow rule that retained every creator reply classified 16 of the original 17. These counts test the declared exclusion policy, not bot identity or marketing effectiveness. The selected rule excludes explicit creator promotion, engagement manipulation, off-platform contact bait and exact long text repeated by three distinct authors. A separate historical six-comment local sample retained five and excluded one creator promotion; the current radar run supplied no new nonzero sample. Recheck the filter against real comments before claiming field performance.

The collector now marks any partial source as an incomplete run. The findings JSON, Markdown and HTML expose exact source-health counts and failure reasons. A legacy manifest without source rows shows that detail is unavailable.

## Reuse in a future marketing stack

Retain the harness contracts: source ID and canonical URL, publication and collection times, authority and category, source status and error, raw item count, claim-cluster ID, transcript kind, comment lane and exclusion reason, and an experiment verdict tied to a dated business-outcome denominator. Keep popularity and comment sentiment separate from qualified leads, incremental sales and contribution margin. Source candidates remain proposals until provenance and outcome checks pass.

The next useful business experiments are conditional leads: compare query-level paid-search capture against qualified leads and contribution; segment AI Overview exposure against Search Console clicks and downstream demand; and calculate first-order contribution plus cohort payback before accepting an ecommerce acquisition target. Each requires the relevant account's own outcome data and a predeclared comparison window.
