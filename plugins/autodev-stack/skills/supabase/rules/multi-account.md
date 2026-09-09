# Multiple Supabase accounts

Resolve the target project and account from the current project configuration
and mandate, not a folder-name guess. Verify the installed CLI's `--profile`
support and relevant command help. Supported profiles or a scoped
`SUPABASE_ACCESS_TOKEN` can select credentials; neither authorizes a new target.

Use only configured credentials associated with the verified target. Keep token
values out of commands shown to the user and out of logs. When changing a
process environment temporarily, restore its previous value afterwards.

If the expected credential is absent or rejected, report that specific gap and
continue independent work. Do not silently fall back to the default login or
deploy all functions merely to test authentication.

[Supabase CLI reference](https://supabase.com/docs/reference/cli/introduction)
documents current profile, login and command-specific target support.
