---
name: supabase-postgres
description: Postgres performance optimization and best practices from Supabase. Use when writing queries, designing schemas, or optimizing database performance.
user-invocable: true
triggers: postgres, sql optimization, query performance, rls, database
---

# Supabase Postgres Best Practices

Comprehensive Postgres performance optimization guide from Supabase.

## When to Apply

- Writing SQL queries or designing schemas
- Implementing indexes or query optimization
- Reviewing database performance issues
- Configuring connection pooling
- Working with Row-Level Security (RLS)

## Rule Categories by Priority

| Priority | Category | Impact | Rules |
|----------|----------|--------|-------|
| 1 | Query Performance | CRITICAL | Missing indexes, composite indexes, covering indexes |
| 2 | Connection Management | CRITICAL | Pooling, limits, idle timeout, prepared statements |
| 3 | Security & RLS | CRITICAL | RLS basics, RLS performance, privileges |
| 4 | Schema Design | HIGH | Data types, PKs, foreign key indexes, partitioning |
| 5 | Concurrency & Locking | MEDIUM-HIGH | Short transactions, deadlock prevention, advisory locks |
| 6 | Data Access Patterns | MEDIUM | N+1 queries, pagination, batch inserts, upsert |
| 7 | Monitoring | LOW-MEDIUM | EXPLAIN ANALYZE, pg_stat_statements, vacuum |
| 8 | Advanced | LOW | Full-text search, JSONB indexing |

## Quick Reference

### Missing Indexes (Critical)
```sql
-- BAD: Full table scan
SELECT * FROM orders WHERE customer_id = 123;

-- GOOD: Add index
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
```

### N+1 Queries (Critical)
```sql
-- BAD: N+1 queries
SELECT * FROM orders WHERE id = 1;
SELECT * FROM customers WHERE id = (order.customer_id); -- repeated

-- GOOD: Single join
SELECT o.*, c.*
FROM orders o
JOIN customers c ON o.customer_id = c.id
WHERE o.id = 1;
```

### RLS Performance (Critical)
```sql
-- BAD: Function call in RLS (slow)
CREATE POLICY "users" ON profiles
  USING (user_id = get_current_user_id());

-- GOOD: Use auth.uid() directly
CREATE POLICY "users" ON profiles
  USING (user_id = auth.uid());
```

### Connection Pooling
```
Supabase default: Transaction mode (pgbouncer)
- Use for serverless/edge functions
- Prepared statements require session mode
- Set pool size based on: max_connections / num_instances
```

### Foreign Key Indexes
```sql
-- Always index foreign keys!
ALTER TABLE orders ADD CONSTRAINT fk_customer
  FOREIGN KEY (customer_id) REFERENCES customers(id);

-- Add the index
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
```

## Detailed References

Load specific rules for detailed guidance:

| File | When to Load |
|------|--------------|
| `references/query-missing-indexes.md` | Query optimization |
| `references/conn-pooling.md` | Connection issues |
| `references/security-rls-performance.md` | Slow RLS policies |
| `references/security-rls-basics.md` | Setting up RLS |
| `references/data-n-plus-one.md` | Multiple query issues |
| `references/schema-foreign-key-indexes.md` | Schema design |
| `references/monitor-explain-analyze.md` | Query debugging |
| `references/_sections.md` | Full rule index |

## Integration

This skill auto-loads with:
- `supabase` - CLI patterns
- `audit` - Database performance agent

Source: [supabase/agent-skills](https://github.com/supabase/agent-skills)
