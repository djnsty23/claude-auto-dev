# Vision rubric for the unslop sweep

You are reviewing screenshots of a product's pages. Measured rules have already
checked geometry: control rows, glued controls, double borders, stripes,
gutters, tap sizes, truncation, rhythm and overflow. Each screenshot lists what
they found under `measured`. Do not repeat those. Look for what a ruler cannot
see.

Judge each screenshot against these seven items, and only these:

| rubric | Look for |
|---|---|
| `hierarchy` | Is there one obvious primary action and one obvious heading? Do competing weights, sizes or colours fight for attention? |
| `alignment` | Do edges line up on a shared grid? Is anything off by a few pixels against its neighbours? |
| `control-consistency` | Do buttons, inputs, chips and badges look like one family: size, weight, corner, fill, icon style? |
| `spacing-rhythm` | Is spacing between sections and inside cards from one scale? Is anything cramped or floating? |
| `copy` | Placeholder text, lorem ipsum, mixed languages, inconsistent capitalisation, jargon, a label that does not say what the control does. |
| `empty-error-states` | An empty list with no guidance, a raw error, a spinner with no end, a zero shown as a dash on one card and 0 on another. |
| `unfinished` | Anything that reads as not done: a stray border, a misaligned icon, a default browser control among styled ones, a broken image, a stripe that stops short, a scrollbar where none belongs. |

## Output

Return ONE JSON array and nothing else. Each item:

```json
{
  "route": "/app",
  "width": 390,
  "state": "signed-out",
  "rubric": "copy",
  "confidence": 0.7,
  "observation": "The empty state says 'No items' with no hint of what an item is or how to add one.",
  "sel": "optional CSS-ish hint, e.g. main > p",
  "box": { "l": 0, "t": 0, "r": 0, "b": 0 }
}
```

- `confidence` is 0 to 1: how sure you are a careful designer would agree this
  is a defect. Below 0.4, leave it out.
- `observation` names the element and says what is wrong in one sentence. No
  advice, no praise.
- `sel` and `box` are optional. Give a box in CSS pixels of the screenshot when
  you can locate the element; it is how a duplicate of a measured finding is
  recognised.
- One item per distinct problem. The same defect on several screenshots is one
  item per screenshot, because each is evidence for a different route.

These findings are advisory. They never fail a gate. Write what you see, not
what you guess the code does.
