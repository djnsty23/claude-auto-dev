# RLS Policy Patterns

## User Owns Row
```sql
CREATE POLICY "owner_access"
  ON public.table_name FOR ALL
  USING (auth.uid() = user_id);
```

## Public Read, Auth Write
```sql
CREATE POLICY "public_read"
  ON public.table_name FOR SELECT
  USING (true);

CREATE POLICY "auth_write"
  ON public.table_name FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);
```

## Role-Based Access
```sql
CREATE POLICY "admin_all"
  ON public.table_name FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );
```

## Team Membership
```sql
CREATE POLICY "team_access"
  ON public.team_resources FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.team_members
      WHERE team_id = team_resources.team_id
      AND user_id = auth.uid()
      AND status = 'active'
    )
  );
```

## Share Token Access
```sql
CREATE POLICY "token_access"
  ON public.shared_resources FOR SELECT
  USING (
    share_token = current_setting('request.headers', true)::json->>'x-share-token'
    AND (expires_at IS NULL OR expires_at > NOW())
  );
```
