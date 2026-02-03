---
name: browser-test
description: Browser testing patterns using agent-browser CLI (5-6x more token-efficient)
allowed-tools: Bash
---

# Browser Testing with agent-browser

## Install
```bash
npm install -g agent-browser && agent-browser install
```

## Common Patterns

**Navigate and verify:**
```bash
agent-browser run --task "Go to http://localhost:3000/login and verify the login form is visible"
```

**Fill form and submit:**
```bash
agent-browser run --task "Go to http://localhost:3000/login, enter email 'test@example.com' and password 'testpass', click Sign In, verify redirect to dashboard"
```

**Check responsive layout:**
```bash
agent-browser run --viewport 375x667 --task "Go to http://localhost:3000 and verify mobile navigation works"
```

**Screenshot:**
```bash
agent-browser run --task "Go to http://localhost:3000/dashboard" --screenshot .claude/screenshots/dashboard.png
```

## Test Account
- Email: `TEST_USER_EMAIL` env var
- Password: `TEST_USER_PASSWORD` env var

## Options
- `--timeout 30000` - increase timeout
- `--viewport 375x667` - mobile viewport
- `--screenshot path.png` - save screenshot
