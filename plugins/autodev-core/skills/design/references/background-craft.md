# Background-led heroes

Load when a surface is going to lead with a photographic or generated background
rather than a solid colour: a landing page hero, a section divider, a marketing
site, an empty state that has to carry atmosphere.

The parent skill's "Backgrounds & Visual Details" section covers backgrounds you
draw in CSS. This covers backgrounds you source or generate, which fail in
different ways.

## What the technique actually buys

The pattern is easy to misread as decoration. It is a hierarchy decision.

A background-led hero shows **no product UI at all**. The headline and one call
to action sit on an image, and the first screenshot of the actual interface does
not appear until the reader has scrolled past it. When the UI does arrive, it is
matted onto an image rather than floating on white.

That sequencing is the whole point. The hero has one job, which is to be read,
and an image with deliberate empty space has nothing competing for attention.
A hero carrying a headline, a subhead, two buttons, a screenshot and a logo bar
has five things at the same volume, which is the density failure the parent
skill's quality gate already tests for.

So the question to answer before sourcing anything: **what is the one thing this
hero must communicate?** If the answer is "the product", a background hero is the
wrong call and a well-shot interface screenshot is better. If the answer is a
feeling, a category, or a promise, the background earns its place.

## Production pipeline

| Step | What it produces | The detail that decides quality |
|---|---|---|
| Source | A reference image | Boards and pins beat prompt-only generation, because "show me more like this" is a better search interface than a text box. Generated-image galleries dead-end after a few hops |
| Restyle | Your version of it | Keep the composition, change the palette and subject. Image models vary in how far they drift from a reference; test one against another on the same input before trusting either |
| Reframe | A 16:9 or wider crop | Sourced images are usually portrait. Generative expand fills the new area |
| Animate | A short loop | Image as start frame, prompt for subtle motion and an explicitly static camera |
| Assemble | The hero | Video element, poster frame, text layer, reduced-motion fallback |

Steps 1 to 4 are manual and happen outside the codebase. Step 5 is the part that
gets reviewed, and it is where the checkable rules below apply.

### Reframing: composition and copy placement are one decision

The most common failure is expanding a portrait image to 16:9, admiring it, and
then discovering there is nowhere to put the headline.

Decide the text box first. Before expanding, mark where the headline, the
subhead and the call to action will sit, then expand so that region lands on the
calmest part of the frame. Sky, water, fog, gradient falloff and out-of-focus
depth all work. Horizon lines, faces, hard edges and high-frequency texture do
not.

A useful constraint: the text region should be able to lose its scrim entirely
and still be readable. If the copy only works because of a dark overlay, the
crop is wrong and the overlay is compensating for it.

### Animating: the prompt is a restraint instruction

Two properties make a background loop work, and both are things you ask the
model **not** to do:

- **The camera does not move.** A drifting or pushing camera turns a background
  into a shot, and a shot competes with the text. Say so explicitly in the
  prompt; models default to camera movement because it reads as cinematic.
- **The motion is ambient.** Clouds, water, dust, light shift, slow particle
  drift. Anything with a beginning and an end will read as a loop seam.

Prefer a model that accepts your image as a **start frame**. Text-to-video means
regenerating the composition you already approved, and you will not get it back.
Start-frame support is a hard filter on model choice, not a nice-to-have.

Budget the file. A hero video that costs more than the rest of the page defeats
the purpose:

| Property | Target | Why |
|---|---|---|
| Duration | 4 to 8 seconds, looped | Longer buys nothing; nobody watches a background |
| Weight | Under 2 MB, ideally under 1 MB | It blocks nothing but competes for bandwidth with the fonts and the LCP image |
| Codec | Both an `h264` mp4 and a `webm`, mp4 last in source order | Broadest support with the smaller file preferred |
| Resolution | 1920 wide is enough | It sits behind text and is often blurred or dimmed |

If the loop cannot hit those numbers, ship the still image. A still that loads
instantly beats a video that arrives after the fold has been read.

## Implementation rules

### The video element

```html
<video
  class="hero-bg"
  autoplay muted loop playsinline
  preload="metadata"
  poster="/hero-poster.avif"
  aria-hidden="true">
  <source src="/hero.webm" type="video/webm">
  <source src="/hero.mp4" type="video/mp4">
</video>
```

Every attribute there is load-bearing:

- `muted` and `playsinline` together are what allow autoplay on mobile. Without
  `playsinline` the video opens fullscreen on some devices.
- `poster` is what renders during load and what remains if the video never
  plays. It must be a real frame from the loop, not a different image, or the
  swap is visible.
- `aria-hidden="true"` because the background carries no information. If it
  does carry information, it is not a background.
- `preload="metadata"` rather than `auto`, so the hero video does not compete
  with the fonts and the first paint.

### Reduced motion is not optional here

A full-viewport moving background is the strongest possible trigger for motion
sensitivity. Honour the preference by not playing at all:

```css
@media (prefers-reduced-motion: reduce) {
  .hero-bg { display: none; }
  .hero { background-image: url("/hero-poster.avif"); background-size: cover; }
}
```

Pausing is not sufficient. A video element that autoplays and then pauses has
already moved.

### Legibility is measured on the rendered surface

The parent skill's rule applies with force here: a static contrast checker
assumes a flat background and will report nonsense against an image.

Measure the real thing. Sample the rendered pixels underneath the text at the
viewports the text is actually read at, and check the worst case rather than the
average. A headline that clears 4.5:1 against the mean brightness of a sky can
still be unreadable where it crosses a cloud.

Two failure modes specific to this technique:

- **The background is not one background.** A generated video changes brightness
  over its loop. Contrast that passes on frame 1 can fail on frame 90. Check the
  brightest frame of the loop, not the poster.
- **The crop changes on mobile.** `object-fit: cover` on a 16:9 asset in a tall
  viewport crops the sides and pushes the calm region out of frame, so the text
  lands somewhere the composition never accounted for. Either art-direct a
  separate portrait asset, or set `object-position` per breakpoint and verify at
  390px and 414px.

### Scrims, when you need one

A scrim is a fix for a crop you cannot change. Prefer fixing the crop.

When a scrim is genuinely needed, a gradient masking only the text region beats
a flat overlay across the whole frame, because a flat overlay dims the part of
the image you chose the image for. On a high-contrast background such as a dark
sky, delete the overlay entirely rather than tuning it; generated hero layouts
often ship one by default whether or not the image needs it.

Hardcoded colours are permitted on this surface. The parent design-token rule
carves out exactly this case: text over a dynamic image background cannot use a
theme token, because there is no theme token for "whatever this pixel is".

## Slop tells specific to this technique

These sit alongside the parent skill's checklist. Any two of them together mean
the hero reads as generated:

| Tell | Why it happens | Fix |
|---|---|---|
| Uniform dark overlay across the entire frame | It is the default output of most generated layouts | Delete it, or mask it to the text region only |
| Camera drift or slow push | The video model's default behaviour | Reprompt with an explicit static-camera instruction |
| Centred headline over a centred subject | Both defaults, compounding | Offset the text into the negative space the crop was built for |
| A visible loop seam | Motion with a start and an end | Pick ambient motion; cross-fade the loop point |
| Text that only works because of the scrim | The crop was chosen before the copy | Re-crop |
| The same stock sky as every other site this quarter | Prompt-only sourcing converges | Restyle the reference rather than shipping it |

## Verification

A background hero is not done until you have looked at it rendered, at the
widths it is read at, with the video actually playing.

| Check | How | Pass condition |
|---|---|---|
| Legibility | Sample rendered pixels under the text, brightest frame of the loop | Worst-case contrast clears the target, not the average |
| Mobile crop | Render at 390 and 414 | The text still sits on the calm region |
| Reduced motion | Toggle the preference, reload | No motion at all, poster visible, text still legible |
| Weight | Network panel, cold load | Video under budget and not blocking first paint |
| Fallback | Block the video request, reload | Poster renders, layout does not shift |
| Autoplay | Real mobile viewport | Plays inline, does not open fullscreen |

The last one needs a device emulation that fires the mobile gates, not a width
change alone. A width-resized desktop browser will autoplay video that a real
phone refuses.
