# Claude Auto-Dev

Autonomous multi-agent development system for Claude Code. Work through tasks without stopping. Run parallel sessions safely. Stay in control with interactive wizards.

## Installation

### Windows (PowerShell)
```powershell
git clone https://github.com/djnsty23/claude-auto-dev "$env:USERPROFILE\claude-auto-dev"
& "$env:USERPROFILE\claude-auto-dev\install.ps1" -Global -Init
```

### Mac/Linux (Bash)
```bash
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
chmod +x ~/claude-auto-dev/install.sh && ~/claude-auto-dev/install.sh --global --init
```

### What Gets Installed

**Global (once per machine):**
- `~/.claude/skills/build.md` - Skill file that triggers on commands

**Per Project (run in project root):**
- `CLAUDE.md` - Project instructions
- `prd.json` - Task list (source of truth)
- `progress.txt` - Learnings log
- `.claude/briefs/` - Optional task specs

---

## Commands

| Command | Purpose |
|---------|---------|
| `auto` | Work through ALL tasks without stopping |
| `continue` | One task at a time, ask before next |
| `status` | Show progress summary |
| `brainstorm` | Discovery questionnaire → generate new stories |
| `adjust` | Pick which feature set to work on next |
| `build [goal]` | Generate tasks from a goal description |
| `stop` | Clear your claims before closing session |
| `reset` | Clear all claims after crash |

---

## Workflow

### Starting Fresh
```bash
cd my-project
~/claude-auto-dev/install.ps1 -Init    # Windows
~/claude-auto-dev/install.sh --init    # Mac/Linux

claude "brainstorm"    # Interactive questionnaire to generate tasks
claude "auto"          # Start building
```

### Daily Development
```bash
claude "status"        # See where you left off
claude "auto"          # Continue building
claude "stop"          # Before closing
```

### Parallel Sessions
```bash
# Terminal 1
claude "auto"

# Terminal 2
claude "auto"

# Terminal 3
claude "auto"
```
Each agent auto-coordinates. No configuration needed.

---

## Interactive Wizards

### Brainstorm (Discovery)
Run `brainstorm` to generate new stories through guided questions:
1. What's frustrating you about the app?
2. Who uses this and what do they need?
3. How big should these features be?
4. Any specific ideas? (free text)

Then pick which generated stories to add.

### Adjust (Prioritization)
Triggers automatically every 5 tasks, or run `adjust` manually:
1. Groups remaining tasks by feature area
2. Presents options: pick a group, do all, or custom input
3. Reprioritizes prd.json based on selection

---

## Task Schema

```json
{
  "id": "S1",
  "title": "Short title",
  "description": "What to build",
  "priority": 1,
  "passes": false,
  "claimedAt": null,
  "completedAt": null,
  "group": "UI Polish",
  "files": ["path/to/file.ts"],
  "acceptanceCriteria": ["Testable requirement"]
}
```

**Key fields:**
- `passes` - true/false (the source of truth)
- `claimedAt` - ISO timestamp for multi-agent coordination
- `group` - Optional category for adjust wizard

---

## How Multi-Agent Works

```
1. Read prd.json
2. Find available tasks (passes=false, not recently claimed)
3. Calculate offset based on active agents
4. Pick task at offset position (spreads load)
5. Claim it immediately (claimedAt = now)
6. Verify claim wasn't overwritten (retry if collision)
7. Implement task
8. Run build, mark passes=true if success
9. Repeat
```

**Collision avoidance:**
- Simultaneous starts: random offset 0-2
- Staggered starts: offset = active_count
- Edge cases: verify + retry
- Abandoned claims: 30-minute expiry

---

## File Structure

```
my-project/
├── CLAUDE.md           # Project instructions
├── prd.json            # Task list
├── progress.txt        # Learnings log
└── .claude/
    └── briefs/         # Optional detailed specs
        ├── S42-rate-limiting.md
        └── S43-auto-save.md
```

---

## Tips

1. **Small tasks** - Each should be completable in one session
2. **Clear acceptance criteria** - Makes "passes" unambiguous
3. **Use briefs for complex tasks** - Add context in `.claude/briefs/SXX-*.md`
4. **Run brainstorm periodically** - Keeps the backlog fresh
5. **Stop before closing** - Prevents claim lockout

---

## License

MIT
