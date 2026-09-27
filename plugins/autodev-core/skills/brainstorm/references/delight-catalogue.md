# Delight catalogue

Personal touches that make a working product feel made for the person using it.
`brainstorm` reads this from the second improvement pass onward (its Step 5) and
proposes at least three entries that fit the product. Every entry is a proposal.
It reaches the operator as an options artifact and a panel, and nothing here is
built unasked.

The entries below came out of one redesign of a calm, night-time product and
are generalised here. Add an entry when a touch lands with an operator: it needs
the pattern, one line on when it fits, and one line on its guard.

## How to pick

1. **Profile the product.** Start from brainstorm's Step 1 answers, then add the
   mood it should leave (calm, playful, precise) and which surfaces it has: an
   ambient background, sound, live data, multi-step flows, timed activities.
2. **Keep an entry only when its "When it fits" line matches that profile.**
   Write one sentence per pick tying the touch to what the product is for. A
   touch that would suit any site is decoration.
3. **Skip what the brainstorm history records** as applied or rejected. When
   fewer than three entries fit, propose new touches in the same spirit
   (personal, calendar-true, restrained), or name the entries you weighed and why
   each fails. Never pad.
4. **Make each pick concrete.** Name the instance for this product, what it costs
   (bundle bytes, CPU on a phone, a data source, a licence) and its guard.

## Guards every entry inherits

- Off under `prefers-reduced-motion`, with a static equivalent that still carries
  any information.
- Paused off screen (an IntersectionObserver) and in a hidden tab
  (`visibilitychange`).
- Animates `transform` and `opacity` only: no layout shift, no endless loop on a
  paint property.
- Decorative layers are `aria-hidden` and never the only carrier of information.
- Never asks for a permission (location, notifications, microphone) in order to
  decorate. Derive from what the browser already says: time zone, locale, clock,
  colour scheme.
- One signature moment per screen, per `rule-design-system`.
- A way to force it on demand (a query flag or a dev toggle). A touch that fires
  once a year cannot otherwise be verified.

## The catalogue

### 1. The visitor's own context as ambience

- **Pattern.** Render the visitor's real surroundings from what the browser
  already knows. The IANA time zone names a representative place, and with the
  clock that gives the local sidereal time, so the page can show the night sky
  overhead (its stars and constellations), tonight's moon phase and the local
  sunset.
- **When it fits.** The product has a mood (calm, sleep, travel, weather,
  reflection) and a background that is currently only decorative.
- **Guard.** Never prompt for geolocation, and keep the derived place on the
  device. A place inferred from a time zone can be hundreds of kilometres off, so
  any label that shows it says it is approximate.

### 2. Rare, calendar-true events

- **Pattern.** Small events tied to the real calendar: a meteor shower on its
  real peak nights, a falling star now and then, a comet, a seasonal easter egg
  on the right date (a tiny sleigh crossing the night sky on 24 December).
- **When it fits.** The product already has an ambient layer (entry 1, a sky, a
  landscape, a hero illustration) and people come back often enough to notice.
- **Guard.** Rare by design, from a per-visit probability or a real date window.
  Never on the first screen as an interruption and never over content or
  controls. Dates come from a published calendar checked for the current year,
  not recalled.

### 3. Numbers that roll like an odometer

- **Pattern.** When a number changes, each digit rolls in the direction of the
  change, up for an increase and down for a decrease, instead of the text
  swapping.
- **When it fits.** The product shows counts, prices, scores, timers or stats
  that change while the person watches, or that arrive after first paint.
- **Guard.** The roll ends on the server-rendered value, and the DOM holds a true
  value at every moment. A count-up that hydrates to zero and waits to be
  scrolled into view shows a wrong number to anyone who reads the page early.
  Accessible text sits beside `aria-hidden` digits, and tabular numerals keep the
  width still.

### 4. Multi-step flows that narrate progress

- **Pattern.** A progress motif (a line, a path, a chain of stars) draws itself
  to the next step, and the next panel rises in, instead of a hard swap.
- **When it fits.** Onboarding, checkout, a quiz, a setup wizard: any flow of
  three or more steps.
- **Guard.** Short enough that a fast user never waits on it, and interruptible:
  a click during the transition lands. Focus moves to the new step's heading, and
  Back plays the motion in reverse.

### 5. A countdown before timed activity, and a resting state that fits

- **Pattern.** A 3-2-1 countdown before anything timed starts: a breathing
  exercise, a timer, a quiz round, a recording. When it ends, the resting state
  says so in text that fits its container.
- **When it fits.** Any timed activity, most of all one where the person looks
  away from the screen once it starts.
- **Guard.** The countdown can be skipped or switched off and is announced to
  screen readers. The resting text is checked at 390 and 414 wide in every locale
  the product ships, since a translation is often longer.

### 6. Living data visualisations

- **Pattern.** Data that breathes. Lights or points pulse gently, each at its own
  rhythm. On load, a short replay of the recent past plays before settling on
  now. An alternate view of the same data is one toggle away, for example a flat
  map and a draggable globe.
- **When it fits.** The product shows live or time-series data with a spatial or
  temporal shape, and people watch it rather than query it.
- **Guard.** A visible pause control, which WCAG 2.2.2 requires for automatic
  motion lasting over five seconds. The replay is skippable and ends on the
  current value. Both views read one data source, the toggle keeps the
  selection, and the heavy view loads only when chosen.

### 7. Refined audio and a licensed media library

- **Pattern.** Where the product already has sound, vary it: several takes of one
  cue, slight changes of pitch and timing, one coherent palette, so repetition
  never grates. Curate a media library whose every file carries a licence checked
  for commercial use and for self-hosting.
- **When it fits.** The product already has sound or media (meditation, games,
  timers, music, video backgrounds). Adding sound to a silent product is not a
  delight.
- **Guard.** Sound stays off until the person turns it on, and a mute is always
  visible. Each asset has a licence record in the repo (source URL, licence,
  commercial use, self-hosting, attribution text). An asset without one does not
  ship.

### 8. Brand polish, checked on the real surfaces

- **Pattern.** The brand survives outside the page: the favicon at 16, 32 and 180
  (the touch icon), the logo at every size it appears, the Open Graph card as it
  actually renders in a messenger link preview, and JSON-LD that matches what the
  page says.
- **When it fits.** Every product with a public URL. This entry always fits.
- **Guard.** Check the rendered result, not the markup. Look at the favicon in a
  real tab, paste the URL into a messenger and read the preview, and run the
  structured data through a validator. A tag that exists is not a card that
  renders.

### 9. Space use

- **Pattern.** Sibling sections share one column width, so their edges line up
  down the page, and a panel keeps its controls on one row when one row fits.
- **When it fits.** Any page with stacked sections or control panels.
- **Guard.** Measure at 390, 414 and desktop. Sibling edges that differ by a few
  pixels read as a mistake. A control row that wraps with room to spare points at
  a `max-width` or `flex-basis` narrower than its content needs.

### 10. Pick up where they left off

- **Pattern.** Long content remembers how far the person got on this device: a
  story, an article, a course, a video. "Carry on" opens at that point, with a
  quiet way back to the start.
- **When it fits.** Anything read, watched or listened to in more than one sitting.
- **Guard.** Stored on the device only, never sent anywhere, and dropped once the
  end is reached. A missing or unreadable record opens at the start, never an
  error.
