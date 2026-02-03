# {{NAME}}

## Quick Start
```bash
npm run dev    # http://localhost:3000
npm run build
```

## Commands (v4.3)
| Say | Action |
|-----|--------|
| `auto` | Work through all tasks autonomously |
| `status` | Show sprint progress |
| `brainstorm` | Scan codebase → propose → create stories |
| `audit` | Parallel quality audit (6 agents) |
| `sprint` | Create/advance sprint |
| `verify` | Quality checks on completed work |
| `deploy` | Build and deploy |
| `clean` | Remove temp files |

## Task Schema
| File | Purpose |
|------|---------|
| `prd.json` | Stories with `passes: true/null/"deferred"` |
| `progress.txt` | Append-only learnings log |

- Story format: `S[sprint]-[number]` (e.g., S1-001)
- `npm run typecheck && npm run build` must pass
- Browser verification for UI changes
