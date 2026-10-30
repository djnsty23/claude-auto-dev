---
name: thrift
description: "Find the best value before recommending or running anything paid: state the job, survey every credible provider and host, check each one can do the job, normalise prices to the unit of work, then test the cheapest viable option once on the exact inputs before scaling up."
when_to_use: "Invoked when the user says \"thrift\", \"cheaper\", \"best bang for buck\", \"best value\", \"is it worth it\", \"which plan\" or \"alternatives\", and before you recommend, quote or run any paid service, model, API, plan, subscription or credit pack, including a first paid test."
allowed-tools: Bash, Read, Grep, Glob, WebFetch, WebSearch
model: opus
user-invocable: true
argument-hint: "[the job to buy, e.g. '5 s image-to-video with lip-sync to our audio']"
---

# Thrift

A paid recommendation made from memory or from the first host found is a guess
with a price on it. The cheapest option that cannot do the job is the most
expensive one. This skill picks the best value, and `cost-reconcile` then checks
what was actually billed.

## Step 1: write the job as a spec

One line each: the input (an image and our own audio file, a prompt), the output
(5 s at 720p, a transcript, 1,000 rows), the quality bar (lip-sync to the
supplied voice, not a generated one), and the volume (one test, then about 12
shots with two rerolls each). Also write what the user has already ruled out
(local models, a provider, subscriptions) and keep it ruled out.

Done when a stranger could reject a provider from the spec alone.

## Step 2: survey wide before reading any price

List at least five candidates across these kinds of host, unless fewer exist:

| Kind | Examples of where to look |
|---|---|
| The model's own vendor API | the lab or company that trained it |
| Pay-per-use aggregators | Replicate collections, fal.ai, Together, OpenRouter, the cloud marketplaces |
| Credit or subscription platforms | creator tools that resell many models |
| Specialist tools | a dedicated lip-sync, transcription or upscaling model that pairs with a cheaper base |
| Free tiers and trials | quotas the user already has, open weights the user allows |

A two-stage pipeline counts as one candidate: a cheap silent generator plus a
dedicated finisher can beat one premium model.

## Step 3: check capability before price

For each candidate, read the input schema or API reference and answer the spec
line by line: does it take an image, does it take our audio, what minimum
duration and resolution does it bill. Drop every candidate that fails a line,
and say which line. A marketing page saying "lip-sync" does not mean it syncs to
a supplied file.

## Step 4: read live prices and normalise them

Read each price from the provider's own pricing page today, with the URL and the
date. Many pricing pages are rendered by JavaScript, so a plain fetch returns
nothing: read them in a real browser. Third-party price lists are leads, never
evidence.

Convert every price to the unit of work from Step 1 (cost per 5 s clip at 720p,
then per full job with rerolls). Fold in what the headline hides:

- the minimum billed duration or tokens
- a subscription floor, renewal price and whether unused credits expire
- whether failed or refused runs are billed
- a new account, a new API key or a prepaid top-up, which needs the user's approval

## Step 5: recommend with a table

A table sorted by cost per unit of work, with a capability column, then one
recommendation and its runner-up. A subscription wins only when the planned
volume uses it up. Say the volume that makes it break even.

## Step 6: test once, on the exact inputs

Quote the test (count, unit price, cap) and wait for the user's go. Before
spending, confirm every input file is the one the reference run used: the same
still, the same audio take, the same duration. A test on different inputs
compares nothing and pays for it anyway. Run one prediction, log it with its id,
status and cost, and compare it with the reference before proposing a batch.

## Never

- Recommend a paid route from one source or from memory.
- Run a paid batch before a single test passed on the real inputs.
- Count a run as a test when its inputs differ from the baseline's.
- Open a new paid account or subscription without the user's yes.
