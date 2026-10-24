---
name: cost-reconcile
description: "Reconcile what something costs from the bill, the usage and the quota together, before any spend number is reported or a paid run starts: charged unit, billed versus gross versus pending, invoice cadence, built-in limits, and unknown kept apart from zero."
when_to_use: "Invoked when the user says \"cost\", \"how much will it cost\", \"why is X burning\", \"billing\", \"invoice\", \"quota\", \"usage limit\", \"spend\" or \"minutes\", when a number about money, credits, minutes or tokens is about to go in a report, and before starting any paid batch, rerun or upgrade."
allowed-tools: Bash, Read, Grep, Glob, WebFetch
model: opus
user-invocable: true
argument-hint: "[service, invoice, or the run you are about to start]"
---

# Cost reconcile

A cost figure is three numbers that look like one: what the provider **billed**,
what was **used** before discounts and credits, and what is **pending** and not
yet on an invoice. Every wrong answer in this area came from reading one of them
as another, or from counting in a unit the provider does not charge.

## Step 1: name the charged unit

Read the provider's billing page or docs for the unit it actually charges, before
you count anything. Duration is rarely the unit. CI bills per job, with
per-runner-OS multipliers, so a matrix of six jobs is six charges. Serverless
bills per invocation, per GB-hour or per CPU time. Model APIs bill input, output
and cached tokens at different rates.

Done when you can write the unit, the rate and the source URL in one line.

## Step 2: pull the three numbers for one period

| Number | Where it comes from | Trap |
|---|---|---|
| Billed | The invoice or billing API for a closed period | Annual or prorated lines make one month look like the steady state |
| Gross usage | The usage export, before discounts and included allowance | Reported as spend when the plan absorbed it |
| Pending | Current-period usage not yet invoiced | Added to a subtotal that already contains it |

Pick one period and say whether it is closed. Read the invoice cadence from at
least two invoices before you project a monthly figure.

Done when each row has a value, a period and the command or page that gave it.

## Step 3: check the limits before the alarm

A budget alert only reports. A built-in quota or spend cap stops the spend.
Before warning that a cost is unbounded, read which caps exist and where they
sit. Before saying something is free, read the free-tier ceiling and how close
current usage is to it.

## Step 4: attribute, if the question is "why"

"Why is X burning N" is answered by a ranked breakdown, never by one suspect.
Group usage by the provider's own dimensions (workflow, job, trigger, function,
model, project), rank the top contributors, and compare them with a baseline
period of the same length. Name what changed between the two periods.

## Step 5: keep unknown apart from zero

A failed API call, an empty page or a pagination parse error is **unknown**, not
zero. Print the population you read (rows, pages, days) beside every total. A
total with no population is a guess with a number on it.

## Before a paid run

State the projected cost from Step 1's unit and rate, the population it runs
over, and a cap. Run the smallest representative slice first and compare its
real cost with the projection. Start the full run only when the slice lands
inside the estimate, and ask first where policy treats the spend as the
operator's call.

## Report

One table: component, period, unit, quantity, rate, billed or projected, and
evidence. Tag each figure measured (name the probe) or inferred. Put any
component you could not read in its own row as unknown.
