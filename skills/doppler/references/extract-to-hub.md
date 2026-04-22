# Extracting Shared Secrets to Hub Projects

Use these patterns when you notice the same secret in 2+ app projects (migrate once, rotate forever after).

## Shared API keys → `ai-keys` hub

For a secret reused across multiple apps (e.g., `GEMINI_API_KEY`):

```bash
# 1. Fetch value from one app
VAL=$(doppler secrets get GEMINI_API_KEY --project app-<source> --config prd --plain)

# 2. Set in hub
doppler secrets set "GEMINI_API_KEY=$VAL" --project ai-keys --config prd >/dev/null

# 3. Replace in source with ref (so rotation propagates)
doppler secrets set 'GEMINI_API_KEY=${ai-keys.prd.GEMINI_API_KEY}' --project app-<source> --config prd >/dev/null

# 4. Set ref in every other app that uses this key
doppler secrets set 'GEMINI_API_KEY=${ai-keys.prd.GEMINI_API_KEY}' --project app-<other> --config prd >/dev/null

# 5. Clear shell var
unset VAL
```

After this, rotating GEMINI_API_KEY is one `doppler secrets set` on `ai-keys/prd` — every spoke app picks up the new value on the next `doppler run`.

## Supabase creds → `supabase` hub with per-project branch configs

Each Supabase project gets its own branch config under `supabase/prd_<name>`:

```bash
# Create branch config if it doesn't exist
doppler configs create "prd_<name>" --project supabase --environment prd

# Populate from source app
for k in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do
  VAL=$(doppler secrets get "$k" --project app-<source> --config prd --plain)
  [ -n "$VAL" ] && doppler secrets set "$k=$VAL" --project supabase --config "prd_<name>" >/dev/null
done

# Point spoke at the new branch config
for k in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do
  doppler secrets set "$k=\${supabase.prd_<name>.$k}" --project app-<source> --config prd >/dev/null
done
```

## Safety rules

- Never echo secret values to the shell (use `--plain` piped directly into `set`, don't print).
- `unset` shell variables that held secrets after the transfer.
- Verify ref resolves before deleting the original:
  ```bash
  doppler run --project app-<source> --config prd -- node -e "console.log(process.env.KEY_NAME ? 'ok' : 'MISSING')"
  ```
