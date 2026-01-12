# $PROJECT_NAME

## Quick Start
```bash
npm run dev    # Start development
npm run build  # Verify before committing
```

---

## Autonomous Development

### Files
| File | Purpose |
|------|---------|
| `prd.json` | Task list - `passes: true/false` is source of truth |
| `progress.txt` | Append-only learnings log |
| `.claude/briefs/` | Optional detailed task specs |

### Commands
| Say | Action |
|-----|--------|
| `auto` | Work through all remaining tasks |
| `continue` | One task, then ask |
| `status` | Show progress |
| `brainstorm` | Discovery questionnaire → new stories |
| `adjust` | Pick which features to work on next |
| `build [goal]` | Generate tasks from description |
| `stop` | Clear claims before closing |
| `reset` | Clear all claims after crash |

---

## Auto Mode Algorithm

```
1. Read prd.json
2. available = stories where passes=false AND (claimedAt null OR >30min old)
3. active_count = count stories where passes=false AND claimedAt <30min old
4. offset = random(0,2) if active_count=0, else active_count
5. Pick available[offset], claim it (claimedAt=now), save IMMEDIATELY
6. Verify claim survived, retry if overwritten
7. Implement task
8. Run build, mark passes=true if success
9. Append to progress.txt
10. After 5 tasks: trigger adjust wizard
11. Repeat
```

---

## Parallel Agents

```bash
claude "auto"   # Terminal 1
claude "auto"   # Terminal 2 (auto-coordinates)
claude "auto"   # Terminal 3
```

---

## Status
- **Complete:** 0 stories
- **Remaining:** 0 stories
- **Progress:** 0%
