## When the comparison is a judgment, judge it blind

Some comparisons have no number: a reviewer reads two implementations, drafts or designs and
picks one. Run those blind, because a label tells the judge which answer the author hoped for.

1. **Strip the labels.** Show the candidates under shuffled neutral ids (X, Y), never "current"
   and "proposed". Keep the id map in a file the judge does not see.
2. **Put the unchanged baseline in the pool, and say so.** One candidate may be what runs today,
   and choosing it is a valid outcome. A change the evidence does not argue for is a regression.
3. **Decide in a fixed order** and stop at the first criterion that separates them: delivery
   (everything the spec names is present), conformance (only what was asked, in the shape asked),
   fidelity (claims checked against the source), internal consistency, operational fitness (the
   real consumer can use it), finish. Length, polish and thoroughness are not merits.
4. **Name the deciding criterion and the runner-up**, with the specific thing that cost it the pick.
5. **Run both presentation orders.** A pick that flips with the order is a tie, and a tie keeps
   the baseline.
