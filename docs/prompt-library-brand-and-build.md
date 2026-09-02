# Prompt library: brand, copy, and a build brief

Extracted from two walkthrough transcripts and generalised. The businesses,
brands and reference URLs both transcripts named are deliberately absent: this
repo is public, and the names were never the reusable part.

These are prompts plus the ORDER they run in, and the order is what makes them
work. Each one exists because the step before it produced an input the next one
needs. Run any of them alone and you get the generic output the sequence exists
to avoid.

## The failure this sequence prevents

Both transcripts name the same mistake from opposite ends.

**Reaching for the generator first.** Opening a design tool and asking for a
flyer or a website before it has been told what the brand is. It has no logo, no
palette and no voice, so it invents one, and the result is competent and
anonymous.

**Asking for the whole artifact in one shot.** A model told to "write my landing
page" writes a page for nobody, because it was never told who is reading it or
what they already believe.

The sequence is: teach the brand, take the STRUCTURE from something that already
converts, mine the voice from the human, then generate.

## 1. Brand guidelines from a visual PDF

For when a designer already delivered guidelines as a visual document. The goal
is a text version a model can parse, not a prettier PDF.

> This is a copy of my brand guidelines PDF from my graphic designer. It is a
> visual PDF. Deeply analyse everything in it: all of the text, the way it is
> laid out, the images, the spacing, every example. Then produce a Markdown
> version of my brand guidelines capturing all the rules about how my logos,
> colours, fonts and spacing should be used in each scenario shown, so that I
> have a document that is easy for a model to parse. Where the PDF demonstrates
> a rule visually rather than stating it, write the rule out in words.

The last sentence earns its place. A visual guideline shows a rule by example and
never states it, so a naive extraction returns the captions and loses the rule.

## 2. Brand guidelines when none exist

For when there is no guidelines document, only artifacts in the wild.

> I want to build my brand guidelines and I do not have any yet. I am giving you
> examples of my brand as it is currently used: web pages, flyers, social
> assets, anything I have. Analyse them as an expert graphic designer would and
> derive the rule set: how the logos, fonts, colours, typography, spacing and
> other assets are actually used, including any inconsistencies between
> examples. Then give me brand guidelines in Markdown. Where the examples
> contradict each other, say so and propose which one to standardise on rather
> than silently picking one.

The contradiction clause is the addition worth keeping. Assets accumulated over
years disagree with each other, and a model asked to summarise them produces a
confident average matching none of them.

## 3. Structure teardown of a page that already works

To get a section-by-section layout from a reference page without copying its
content. The structure is the part that was tested; the words and brand stay
yours.

> I am giving you screenshots of REFERENCE PAGE. I am not a sales page, website
> or UX expert, but I need to create one for my own business. Go through this
> page as a world-class conversion rate optimisation expert would and lay out
> the exact section-by-section structure they used, why each section is there,
> what job it does, and how the page flows from one to the next. Then turn that
> into a reusable playbook for my own page: the section order, what copy belongs
> in each section, and what information I need to collect from myself to fill
> it. I want a template I can run again for other pages, not a description of
> this one.

Capture the reference with a full-page screenshot tool rather than a viewport
grab, or the analysis reads the top third of the page and calls it the structure.

## 4. Mining the voice out of the human

Run before any copy is written. This is the step that separates the output from
generic model prose, and it is the one most often skipped.

> Think like an expert copywriter trying to understand a business well enough to
> write world-class copy for its website. Grill me. Ask me every question you
> need answered to write that copy in MY words about MY business, not recycled
> model output. Ask one question at a time and wait for my answer. Keep going
> until you have everything you need for this page, then tell me what you still
> do not have rather than filling it in yourself.

Two clauses added to the transcript's version, from reasoning this repo already
applies elsewhere. **One question at a time**, because a block of ten questions
gets three answered. And **tell me what you still do not have**, because a model
that silently invents the missing third of a page produces something that reads
fine and is not true.

Dictating the answers beats typing them: spoken answers carry the phrasing the
business actually uses.

Not to be confused with the `grilling` skill in this repo, which attacks the
premise of an engineering plan. Same verb, different job.

## 5. Turning it into a build brief

Once 1 through 4 exist. This is the handoff to whatever generates the artifact.

> You now have my brand guidelines, the section-by-section structure for each
> page, and my answers about the business. Produce a single build brief I can
> hand to a design tool. For each page: the section order, the exact copy for
> each section, what image or asset belongs where, and any interaction or state
> that matters. Where you are using my words, use them verbatim. Where you had
> to write something I did not give you, mark it clearly so I can check it.

The marking instruction is the whole value of this step. Without it the brief
mixes quoted material with invented material and nothing tells them apart later.

## 6. Editing the first draft

The generated artifact is a draft. Three edit surfaces, in increasing blast
radius:

| surface | use when |
|---|---|
| a comment on the element | the change is local; the anchor is unambiguous in a way a chat description is not |
| chat | the change spans the page: a theme toggle, a restructured section |
| regenerate | the structure itself is wrong, which usually means step 3 produced the wrong playbook |

## Appendix: installing and vetting agent capabilities

From the second transcript. Same artifact type, different job, kept separate.

### Have the agent install a repo

> Set up REPO for me. Clone GITHUB URL, read its INSTALL.md first and follow it
> rather than guessing, install any system dependencies it names, register it as
> a skill for the agent I am using, and ask me for any API key when you reach
> the step that needs it rather than up front.

Two clauses change the outcome. Without **read the INSTALL.md first**, the agent
installs from its prior about how such repos usually work. Without **ask when you
reach the step**, it demands every credential before knowing which are needed.

### Scan a capability before installing it

Directly relevant here, because this repo IS a plugin marketplace. A skill is not
inert text: it carries instructions, scripts, dependencies and tool access, and
installing one from a stranger grants all of that.

The transcript names a scanner covering prompt injection, data exfiltration,
supply chain risk and hidden instructions. Whether that specific tool is worth
adopting is a separate decision needing its own evaluation, and this document
does not make it. The durable rule is:

**Scan a capability before granting it tool access**, and prefer a scanner that
can run without sending file contents to a third-party model when the files are
private.

### Draft order for anything written

> Write the rough draft yourself, including the messy parts, then have the model
> strip the patterns that make writing feel machine-generated while preserving
> your voice.

Human first, model second. The reverse produces text that is clean, symmetrical
and indistinguishable from everyone else's, and the interesting parts are what
get sanded off.
