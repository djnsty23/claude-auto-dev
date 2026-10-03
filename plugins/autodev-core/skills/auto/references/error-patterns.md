# Error patterns

Common error patterns auto recognizes across tasks, each with its instant fix.

Common patterns to recognize:
| Error Pattern | Instant Fix |
|--------------|-------------|
| `exactOptionalPropertyTypes` error | Add `\| undefined` to optional prop types: `foo?: string \| undefined` |
| `Cannot find module './X'` | Check file exists, fix path or create file |
| `Type 'X' is not assignable to type 'Y'` | Check the type definition, add union or cast |
| `Property 'X' does not exist on type 'Y'` | Add to interface or use optional chaining |
| `RLS policy violation` | Check auth.uid() in policy, verify user is authenticated |
| `CORS error` | Check API route headers or middleware config |
| `as unknown as` cast | Create a validator function, parse instead of assert |
| Unhandled fetch in component | Wrap in try/catch, check res.ok, add error feedback |
| `<input>` without label | Add `<label htmlFor>` or `aria-label` prop |
| Env var `\|\| ''` fallback | Throw if missing, fallback only with NODE_ENV check |
| Middleware blocks new route | Add to PUBLIC_PREFIXES or route matcher |
| Font declared but not loaded | Add `next/font` import in layout.tsx |
| `hsl(var(--x))` double-wrap | Remove outer `hsl()` when CSS var already contains it |
| Stock shadcn tokens | Read project's globals.css, use actual brand colors |
