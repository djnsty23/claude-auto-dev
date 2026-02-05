---
name: security-patterns
description: Security vulnerability patterns to check during code review. Auto-loaded with review, audit, ship commands.
user-invocable: false
---

# Security Patterns Reference

Quick reference for security vulnerabilities to catch during code review.

## Command Injection

### GitHub Actions Workflows
**Path**: `.github/workflows/*.yml`

**Unsafe** (user input in run command):
```yaml
run: echo "${{ github.event.issue.title }}"
```

**Safe** (use environment variables):
```yaml
env:
  TITLE: ${{ github.event.issue.title }}
run: echo "$TITLE"
```

**Risky inputs to watch:**
- `github.event.issue.title/body`
- `github.event.pull_request.title/body`
- `github.event.comment.body`
- `github.event.commits.*.message`
- `github.head_ref`

### Node.js child_process
**Unsafe**:
```javascript
exec(`command ${userInput}`)
```

**Safe**:
```javascript
execFile('command', [userInput])
```

## Code Injection

| Pattern | Risk | Alternative |
|---------|------|-------------|
| `eval()` | Arbitrary code execution | `JSON.parse()` for data |
| `new Function()` | Code injection | Static functions |
| `pickle` (Python) | Arbitrary code execution | `json` module |
| `os.system()` | Shell injection | `subprocess.run()` with list args |

## XSS (Cross-Site Scripting)

| Pattern | Risk | Alternative |
|---------|------|-------------|
| `dangerouslySetInnerHTML` | XSS if unsanitized | DOMPurify sanitizer |
| `document.write()` | XSS + performance | `createElement` + `appendChild` |
| `.innerHTML =` | XSS if unsanitized | `.textContent` or sanitizer |

## When to Flag

**Always flag:**
- User input flowing into dangerous functions
- Hardcoded secrets/credentials
- Missing input validation at system boundaries

**Don't flag:**
- Internal code with trusted input
- Properly sanitized content
- Test fixtures with mock data

## Integration

This skill auto-loads with:
- `review` - Check changed code for security patterns
- `audit` - Security agent scans for vulnerabilities
- `ship` - Pre-deploy security checklist

Reference: [GitHub Actions Security Guide](https://github.blog/security/vulnerability-research/how-to-catch-github-actions-workflow-injections-before-attackers-do/)
