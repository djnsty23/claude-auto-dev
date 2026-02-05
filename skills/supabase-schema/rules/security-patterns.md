# Security Patterns

## 1. Function Search Path (CRITICAL)
All functions must set search_path:

```sql
CREATE OR REPLACE FUNCTION public.my_function()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public  -- REQUIRED
AS $$
BEGIN
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

## 2. OAuth Token Storage
```sql
CREATE TABLE public.oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.oauth_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own tokens"
  ON public.oauth_tokens FOR ALL
  USING (user_id = auth.uid());
```

## 3. Cryptographic Share Tokens
```sql
CREATE TABLE public.shared_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_token TEXT DEFAULT encode(gen_random_bytes(32), 'hex'),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## 4. Data Retention
```sql
CREATE OR REPLACE FUNCTION cleanup_old_records()
RETURNS void
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.audit_logs
  WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;
```

## 5. Security Checklist

| Check | Action |
|-------|--------|
| RLS enabled? | `list_tables` |
| Functions secure? | `get_advisors(type: "security")` |
| Secrets hardcoded? | Search migrations |
| Tokens expire? | Check expires_at |
| Password protection? | Enable in Auth settings |
