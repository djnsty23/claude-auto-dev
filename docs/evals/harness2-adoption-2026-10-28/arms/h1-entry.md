## Writing a new entry

An entry records what each change did, not only what went wrong.

1. **List every change made while fixing it**, and give each a verdict: `helped`, `hurt`,
   `no observed effect` or `confounded`. Prefer `confounded` when several changes landed together
   and no run isolates one, or when a single run is all that stands behind the difference.
2. **Then write at most one lesson**, with four fields:
   - `cue`: the shape of situation it applies to, so it fires on a different project. Not this
     incident's facts.
   - `lesson`: the operation to perform, naming the file or component it changes.
   - `evidence`: the verdict rows it rests on and the contrast that shows it, such as runs before
     and after, or a revert that brought the failure back.
   - `confidence`: high, medium or low, and why.
3. **A lesson resting only on `confounded` rows is a guess.** Narrow it to what the record shows,
   or write `NO_ENTRY`. That is a valid outcome, and the verdict rows are still worth keeping.
4. Too generic changes nothing ("be careful"). Too specific never fires again ("the fee rose to
   250 on 1 Jan"). Aim between.
