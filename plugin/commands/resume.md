---
description: Resume a previous Claude Code session
---

# Resume Session

## Quick Steps (Same Terminal)

1. Press **Ctrl+C** to exit current session
2. Run: `claude -p --resume`
3. Pick session from list or type search term

## Commands

```bash
claude -p --resume              # Open session picker
claude -p --resume "feature"    # Search for "feature"
claude -p --resume abc123       # Resume by session ID
```

## Tips

- **Stay in Cursor terminal** - no external windows needed
- **-p flag** = bypass permissions (faster startup)
- Session picker shows recent sessions with timestamps
- Type to filter, Enter to select
