---
name: Supabase Schema
description: Manage database schema and migrations using Supabase MCP.
triggers:
  - schema
  - database
  - table
  - migration
  - supabase
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

Use Supabase MCP:
```
list_tables(project_id, schemas: ["public"])
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

**Apply via MCP:**
```
apply_migration(project_id, name, query)
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
