# Browser Testing Patterns

## agent-browser CLI (preferred - 5-6x more token-efficient than Playwright MCP)

### Install
```bash
npm install -g agent-browser && agent-browser install
```

### Common Patterns

**Navigate and verify:**
```bash
agent-browser run --task "Go to http://localhost:3000/login and verify the login form is visible with email and password fields"
```

**Fill form and submit:**
```bash
agent-browser run --task "Go to http://localhost:3000/login, enter email 'test@example.com' and password 'testpass', click Sign In, verify redirect to dashboard"
```

**Check responsive layout:**
```bash
agent-browser run --viewport 375x667 --task "Go to http://localhost:3000 and verify mobile navigation menu works"
```

**Screenshot for verification:**
```bash
agent-browser run --task "Go to http://localhost:3000/dashboard and take a screenshot" --screenshot .claude/screenshots/dashboard.png
```

### Test Account
- Email: Value from TEST_USER_EMAIL env var
- Password: Value from TEST_USER_PASSWORD env var
- Role: Tester (not admin)

### Error Patterns
- Timeout: Increase with `--timeout 30000`
- Element not found: Check if page loaded, try waiting
- Auth required: Login first, then navigate
