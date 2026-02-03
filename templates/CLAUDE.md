# {{NAME}}

## Quick Start
```bash
npm run dev    # http://localhost:3000
npm run build
```

## Commands
| Say | Action |
|-----|--------|
| `auto` | Work through all tasks autonomously |
| `status` | Show sprint progress |
| `brainstorm` | Generate new stories from codebase scan |
| `audit` | Run parallel quality audit (6 agents) |
| `sprint` | Create/advance sprint |
| `verify` | Run quality checks on completed work |
| `deploy` | Build and deploy to production |
| `clean` | Remove screenshots and temp files |
| `checkpoint` | Save context before /clear |

## Files
| File | Purpose |
|------|---------|
| `prd.json` | Tasks with `passes: true/false` |
| `progress.txt` | Append-only learnings log |
| `project-meta.json` | Sprint metadata |

## Task Management
- **prd.json**: Long-term memory (sprints, stories, history)
- **Native Tasks**: Session memory (current work, blockers)
- Stories use format: `S[sprint]-[number]` (e.g., S1-001)

## Quality Rules
- `npm run typecheck` must pass before marking complete
- `npm run build` must succeed
- Browser verification for UI changes
