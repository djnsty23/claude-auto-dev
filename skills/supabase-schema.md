---
name: Supabase Schema Reference
description: SQL patterns, RLS policies, security templates. Use via supabase/SKILL.md.
---

# Supabase Schema Workflow

## On "schema" or "create table"

### Step 1: Determine Action
```
question: "What do you need?"
options:
  - { label: "View schema", description: "See current tables" }
  - { label: "Create table", description: "Add a new table" }
  - { label: "Modify table", description: "Add/change columns" }
  - { label: "Add RLS policy", description: "Row-level security" }
```

### Step 2: View Current Schema

Use Supabase CLI:
```bash
npx supabase db dump --schema public --data-only=false | head -200
# Or connect directly:
psql "$DATABASE_URL" -c "\dt public.*"
```

Report table structure to user.

### Step 3: Create Table

**Gather requirements:**
```
question: "What data will this table store?"
# Parse response to determine columns
```

**Generate migration:**
```sql
-- Migration: create_[table_name]_table
CREATE TABLE IF NOT EXISTS public.[table_name] (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- user columns here
);

-- Enable RLS
ALTER TABLE public.[table_name] ENABLE ROW LEVEL SECURITY;

-- Basic policies
CREATE POLICY "Users can view own data"
  ON public.[table_name]
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own data"
  ON public.[table_name]
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);
```

**Apply via CLI:**
```bash
# Save SQL to migration file first
npx supabase migration new create_[table_name]
# Then apply
npx supabase db push
```

### Step 4: RLS Policies

**Common patterns:**

```sql
-- User owns the row
CREATE POLICY "owner_access"
  ON public.table_name
  FOR ALL
  USING (auth.uid() = user_id);

-- Public read, authenticated write
CREATE POLICY "public_read"
  ON public.table_name
  FOR SELECT
  USING (true);

CREATE POLICY "auth_write"
  ON public.table_name
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- Role-based access
CREATE POLICY "admin_all"
  ON public.table_name
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );
```

### Step 5: Verify

After migration:
```
1. list_tables to confirm table exists
2. get_advisors(project_id, type: "security") to check for issues
3. Report any missing RLS policies
```

## Quick Commands

| Say | Action |
|-----|--------|
| `create users table` | Create basic users/profiles table |
| `add column X to Y` | Add column to existing table |
| `show schema` | Display all tables |
| `check security` | Run security advisors |

## Standard Tables

**profiles (extends auth.users):**
```sql
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Trigger for auto-create profile:**
```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (
    NEW.id,
    NEW.email,
    CASE WHEN NEW.email = 'YOUR_ADMIN_EMAIL' THEN 'admin' ELSE 'user' END
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

## Safety Rules

**ALWAYS:**
- Enable RLS on every table
- Use migrations (not direct SQL) for schema changes
- Include ON DELETE CASCADE for foreign keys
- Add created_at/updated_at columns

**NEVER:**
- Disable RLS in production
- Store sensitive data without encryption
- Use hardcoded IDs in migrations
- Delete tables without confirmation

---

## Security Patterns (Lovable/Supabase Linter Fixes)

### 1. Function Search Path (CRITICAL)
All functions must set search_path to prevent injection:

```sql
CREATE OR REPLACE FUNCTION public.my_function()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public  -- REQUIRED
AS $$
BEGIN
  -- function body
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### 2. Avoid Hardcoded Secrets in Migrations
**BAD:**
```sql
-- DON'T DO THIS
INSERT INTO config (key, value) VALUES ('CRON_SECRET', 'hardcoded-secret');
```

**GOOD:**
```sql
-- Use Supabase Vault or environment variables
-- Secrets go in Edge Function env vars, not migrations
```

### 3. OAuth Token Tables (Sensitive)
```sql
-- Tokens table with proper RLS
CREATE TABLE public.oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.oauth_tokens ENABLE ROW LEVEL SECURITY;

-- Strict user-only access
CREATE POLICY "Users can only access own tokens"
  ON public.oauth_tokens FOR ALL
  USING (user_id = auth.uid());
```

### 4. Share Token Security
```sql
-- Use cryptographically random tokens
CREATE TABLE public.shared_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_token TEXT DEFAULT encode(gen_random_bytes(32), 'hex'),  -- 64 char hex
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),   -- Expiration
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Public access via token (with expiration check)
CREATE POLICY "Access by valid token"
  ON public.shared_resources FOR SELECT
  USING (
    share_token = current_setting('request.headers', true)::json->>'x-share-token'
    AND (expires_at IS NULL OR expires_at > NOW())
  );
```

### 5. Data Retention (Chat History, Logs)
```sql
-- Auto-delete old records
CREATE OR REPLACE FUNCTION cleanup_old_records()
RETURNS void
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.ai_chat_history
  WHERE updated_at < NOW() - INTERVAL '90 days';

  DELETE FROM public.audit_logs
  WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- Schedule via pg_cron (if available) or Edge Function cron
```

### 6. Team Access Validation
```sql
-- Secure team membership check
CREATE OR REPLACE FUNCTION is_team_member(team_uuid UUID)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.team_members
    WHERE team_id = team_uuid
    AND user_id = auth.uid()
    AND status = 'active'  -- Only active members
  );
END;
$$ LANGUAGE plpgsql;
```

### 7. Service Role Policies (Restrict)
```sql
-- BAD: Allows any service role insert
CREATE POLICY "service_insert" ON table FOR INSERT WITH CHECK (true);

-- GOOD: Validate even for service role
CREATE POLICY "validated_service_insert"
  ON public.unsubscribes FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.scheduled_reports
      WHERE id = scheduled_report_id
    )
  );
```

### 8. Security Audit Command
After any schema change, run:
```
get_advisors(project_id, type: "security")
get_advisors(project_id, type: "performance")
```

Fix all WARN/ERROR before deploying.

### 9. Dashboard Setting: Enable Leaked Password Protection
Go to: Supabase Dashboard → Authentication → Settings → Security
Enable: "Leaked password protection" (checks HaveIBeenPwned)

---

## Quick Security Checklist

| Check | Command/Action |
|-------|----------------|
| RLS enabled? | `list_tables` - check rls_enabled |
| Functions secure? | `get_advisors(type: "security")` |
| Secrets hardcoded? | Search migrations for passwords/tokens |
| Tokens expire? | Check expires_at columns |
| Cleanup policy? | Add retention function |
| Password protection? | Enable in Auth settings |

---

## Multi-Account Support

Supabase CLI only supports one login. Workaround using per-project tokens:

### Setup (one-time per account)

1. **Generate access token:**
   Supabase Dashboard → Account → Access Tokens → Generate

2. **Save as system env var (folder name, uppercase):**
   ```
   SUPABASE_ACCESS_TOKEN_DOUGHY=sbp_xxxxx
   SUPABASE_ACCESS_TOKEN_REELR=sbp_yyyyy
   ```

### Usage (automatic)

Before supabase CLI commands:
1. Get folder name: `~/code/doughy` → `DOUGHY`
2. Look for `SUPABASE_ACCESS_TOKEN_DOUGHY`
3. If found, prefix command:

**Windows (PowerShell):**
```powershell
$env:SUPABASE_ACCESS_TOKEN = $env:SUPABASE_ACCESS_TOKEN_DOUGHY
npx supabase functions deploy ...
```

**Mac/Linux:**
```bash
SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN_DOUGHY npx supabase functions deploy ...
```

No token found? Falls back to default login.
