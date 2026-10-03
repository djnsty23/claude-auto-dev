# Self-verification checks

The scripts and the pattern table behind steps 3, 4c and 5 of Self-Verification in the auto skill.

## Resource validation

```bash
# Check image/asset URLs are reachable
grep -rn 'https://.*\.(png|jpg|svg|webp|woff2)' src/ --include="*.tsx" --include="*.ts" | while read line; do
  url=$(echo "$line" | grep -oP 'https://[^\s"'\'']+'); curl -s -o /dev/null -w "%{http_code} $url\n" "$url"
done
```

## Hardening check patterns

| Pattern | What to Check | Fix |
|---------|--------------|-----|
| **Fail-open auth** | `if (secret && ...)` skips auth when env var is unset | Fail-closed: return 401 if env var missing |
| **Unsafe casts** | `as unknown as`, `as any`, double assertions | Create a validator (Zod or manual), parse instead of cast |
| **Fire-and-forget fetch** | `fetch()` without try/catch or `.ok` check | Wrap in try/catch, check `res.ok`, revert optimistic state on failure |
| **Missing form labels** | `<input placeholder="...">` without `<label>` or `aria-label` | Add `<label>` or `aria-label` to every input |
| **Missing autocomplete** | Login/signup inputs without `autoComplete` | Add `autoComplete="email"`, `autoComplete="current-password"`, etc. |
| **User-supplied URLs** | Server-side `fetch(userUrl)` without validation | Validate URL, resolve DNS, block private IP ranges |
| **Env var fallbacks** | `process.env.X \|\| 'localhost'` or `\|\| ''` | Throw if missing in production, only fallback in dev |
| **RLS policy logic** | New table or RLS change | Verify policy restricts to `auth.uid()` for user data |
| **Missing focus styles** | Raw `<button>` without `focus-visible:ring-*` | Add `focus-visible:ring-2 focus-visible:ring-ring` |
| **Stock UI** | Fonts declared but not loaded, text-only nav, generic empty states | Load fonts via next/font, add icons, add visual personality |
| **Dark mode** | Colors that don't use theme tokens, cards same color as background | Use semantic tokens, add elevation distinction |
| **Chart colors** | `hsl(var(--x))` when var already contains `hsl(...)` | Use raw HSL values or remove outer `hsl()` wrapper |

## Design token compliance

```bash
# Check for stock shadcn / hardcoded colors in changed files
git diff --name-only | xargs grep -n "text-white\|bg-black\|text-gray-\|bg-gray-\|#[0-9a-fA-F]\{6\}" 2>/dev/null | grep -v "gradient\|from-\|to-\|via-" | head -10
# Check fonts are loaded, not just declared
grep -rn "fontFamily\|font-family" src/ --include="*.css" --include="*.tsx" | grep -v "next/font\|@font-face\|tailwind" | head -5
```
