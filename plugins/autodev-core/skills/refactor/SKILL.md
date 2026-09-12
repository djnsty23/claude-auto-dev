---
name: refactor
description: Code refactoring patterns - extract, split, restructure without changing behavior.
when_to_use: "Invoked when the user says \"refactor\", \"extract\", \"split\", \"restructure\"."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[target file or pattern]"
---

# Refactoring Patterns

**Rule #1:** Preserve observable behavior. Establish relevant before/after
checks using the project's actual commands; inherited failures and missing
coverage stay explicit. Types/build success alone cannot prove no behavior change.

## When to investigate a refactor

The following sizes are investigation leads, not violations or automatic edit
orders. Preserve cohesive code. Require a concrete maintenance/runtime problem
and compare the proposed boundary with leaving the code intact.

| Signal | Refactoring |
|--------|-------------|
| File > 300 lines | Split into modules |
| Component > 200 lines | Extract sub-components |
| Function > 50 lines | Extract helpers |
| 3+ similar blocks | Extract shared utility |
| Prop drilling > 3 levels | Context or composition |
| God object/file | Single responsibility split |

## Pattern: Split Large File

```
Before: invoiceApi.ts (1240 lines)
After:
  invoiceApi/
  ├── index.ts          (barrel export)
  ├── client.ts         (base client, auth)
  ├── invoices.ts       (invoice creation)
  ├── payments.ts       (payment capture)
  └── types.ts          (shared types)
```

**Steps:**
1. Identify logical groups (by domain, not by size)
2. Create module directory with `index.ts` barrel
3. Move code group by group, fixing imports
4. `npm run typecheck` after each move
5. Barrel export preserves existing import paths

```typescript
// index.ts - barrel export (no breaking changes)
export { InvoiceClient } from './client'
export { createInvoice, voidInvoice } from './invoices'
export { capturePayment } from './payments'
export type { InvoiceParams, PaymentParams } from './types'
```

## Pattern: Extract Component

```tsx
// Before: page.tsx (500 lines)
export default function InvoicesPage() {
  // 50 lines of filter logic
  // 30 lines of bulk actions
  // 200 lines of invoice list
  // 100 lines of pagination
}

// After:
// components/invoices/filter-bar.tsx
// components/invoices/bulk-actions.tsx
// components/invoices/invoice-list.tsx
// components/invoices/pagination.tsx

export default function InvoicesPage() {
  const [filters, setFilters] = useState(defaultFilters)
  const invoices = useInvoices(filters)

  return (
    <div>
      <FilterBar filters={filters} onChange={setFilters} />
      <BulkActions selected={selected} />
      <InvoiceList invoices={invoices} />
      <Pagination total={invoices.total} />
    </div>
  )
}
```

**Rules:**
- Each component gets its own file
- Parent passes data down, children emit events up
- Shared state stays in parent or context
- Co-locate related components in same directory

## Pattern: Extract Hook

```tsx
// Before: logic mixed in component
function InvoiceTable() {
  const [width, setWidth] = useState(0)
  const [compact, setCompact] = useState(false)
  const tableRef = useRef<HTMLTableElement>(null)

  useEffect(() => {
    const table = tableRef.current
    if (!table) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(table)
    return () => observer.disconnect()
  }, [])

  // ... 40 more lines of column-collapse logic

  return <table ref={tableRef}>...</table>
}

// After: clean separation
function InvoiceTable() {
  const { ref, compact, visibleColumns } = useResponsiveColumns(invoiceColumns)
  return <table ref={ref}>...</table>
}
```

## Pattern: Replace Prop Drilling

```tsx
// Before: props passed through 4 levels
<App user={user}>
  <Layout user={user}>
    <Sidebar user={user}>
      <UserAvatar user={user} />

// After: context
const UserContext = createContext<User | null>(null)

function App() {
  return (
    <UserContext.Provider value={user}>
      <Layout><Sidebar><UserAvatar /></Sidebar></Layout>
    </UserContext.Provider>
  )
}

function UserAvatar() {
  const user = useContext(UserContext)
  // ...
}
```

## Pattern: Consolidate Duplicates

```typescript
// Before: 3 similar API calls
async function fetchInvoices() { /* 20 lines */ }
async function fetchCustomers() { /* 20 lines, same pattern */ }
async function fetchPayments() { /* 20 lines, same pattern */ }

// After: generic fetcher
async function fetchFromSupabase<T>(
  table: string,
  query?: SupabaseQuery
): Promise<T[]> {
  const { data, error } = await supabase
    .from(table)
    .select(query?.select ?? '*')
    .order(query?.orderBy ?? 'created_at', { ascending: false })
    .limit(query?.limit ?? 50)

  if (error) throw error
  return data as T[]
}
```

## Safety Checklist

Before refactoring:
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm run test` passes (if available)

After each step:
- [ ] `npm run typecheck` still passes
- [ ] All imports resolve
- [ ] No circular dependencies

After completion:
- [ ] `npm run build` passes
- [ ] Relevant public entrypoints and user flows preserve their before behavior
- [ ] Evidence identifies the tested commit, inputs, outputs and untested scope

## Integration

| Skill | How It Integrates |
|-------|-------------------|
| `auto` | Refactoring stories executed during auto mode |
| `brainstorm` | Proposes refactoring when large files detected |
| `review` | Flags refactoring opportunities |
| `design` | Refactoring must preserve existing UI (see Preserve UI Structure section) |

## Feeding the learning loop

**Threshold — record what broke that the types did not catch.** A refactor the
compiler verified end to end teaches nothing.

The valuable entry is the failure that survived a green typecheck: a runtime
contract, a string key, an ordering assumption, a test that was asserting the old
shape without noticing. Note the class in `.claude/project-rules.md`; it is
the same class the next refactor in this codebase will hit.
