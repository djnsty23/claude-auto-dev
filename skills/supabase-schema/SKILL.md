---
name: supabase-schema
description: SQL patterns, RLS policies, and security templates for Supabase. Loaded with supabase skill.
user-invocable: false
---

# Supabase Schema Reference

## Quick Commands

| Say | Action |
|-----|--------|
| `create users table` | Create basic profiles table |
| `add column X to Y` | Add column to existing table |
| `show schema` | Display all tables |
| `add RLS policy` | Create row-level security |

## Standard Table Template

```sql
CREATE TABLE IF NOT EXISTS public.[table_name] (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Always enable RLS
ALTER TABLE public.[table_name] ENABLE ROW LEVEL SECURITY;

-- User owns row
CREATE POLICY "Users access own data"
  ON public.[table_name] FOR ALL
  USING (auth.uid() = user_id);
```

## Profiles Table (Standard)

```sql
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-create on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

## CLI Workflow

```bash
# View schema
npx supabase db dump --schema public | head -200

# Create migration
npx supabase migration new create_[table_name]

# Apply migration
npx supabase db push
```

## Safety Rules

**ALWAYS:**
- Enable RLS on every table
- Use migrations for schema changes
- Include ON DELETE CASCADE for FKs
- Add created_at/updated_at columns

**NEVER:**
- Disable RLS in production
- Hardcode secrets in migrations
- Delete tables without confirmation

## Detailed Rules

| Rule | When to Load |
|------|--------------|
| `rules/rls-patterns.md` | RLS policy examples |
| `rules/security-patterns.md` | Security hardening |
| `rules/multi-account.md` | Multi-account CLI setup |
