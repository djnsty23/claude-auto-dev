# Multi-Account Support

Supabase CLI only supports one login. Workaround using per-project tokens.

## Setup (one-time per account)

1. **Generate access token:**
   Supabase Dashboard → Account → Access Tokens → Generate

2. **Save as system env var:**
   ```
   SUPABASE_ACCESS_TOKEN_PROJECTNAME=sbp_xxxxx
   ```

## Usage

Before supabase CLI commands:
1. Get folder name: `~/code/myproject` → `MYPROJECT`
2. Look for `SUPABASE_ACCESS_TOKEN_MYPROJECT`
3. If found, prefix command:

**Windows (PowerShell):**
```powershell
$env:SUPABASE_ACCESS_TOKEN = $env:SUPABASE_ACCESS_TOKEN_MYPROJECT
npx supabase functions deploy
```

**Mac/Linux:**
```bash
SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN_MYPROJECT npx supabase functions deploy
```

No token found? Falls back to default login.
