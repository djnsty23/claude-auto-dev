# Auth Token Injection for Automated Testing

Quick login method for agent-browser when Google OAuth blocks automated browsers.

## Quick Reference

```bash
# 1. Open browser in headed mode
agent-browser open http://localhost:8080 --headed

# 2. Inject token (paste as single-line JSON with escaped quotes)
agent-browser eval "localStorage.setItem('sb-xxxxxxxxxxxxxxxxxxxxx-auth-token', '[TOKEN_JSON]'); location.reload();"

# 3. Navigate to Compare page for GA4 data testing
agent-browser goto http://localhost:8080/compare
```

## When to Use

- Google shows "Couldn't sign you in - This browser or app may not be secure"
- Testing apps that use Supabase + Google OAuth
- Need to test authenticated features with agent-browser

## Step 1: Ask User for Tokens

Ask the user to provide their localStorage values from Chrome DevTools:

```
To test authenticated features, I need your session tokens.

In your Chrome browser (where you're logged in):
1. Open DevTools (F12)
2. Go to Application → Local Storage → [your-app-url]
3. Copy these values:
   - sb-[project-id]-auth-token (the full JSON value)
   - Any other app-specific keys (theme, preferences, etc.)

Paste them here and I'll inject them into the test browser.
```

## Step 2: Inject Tokens

Start agent-browser in visible mode:
```bash
agent-browser open http://localhost:8080 --headed
```

Inject the Supabase auth token:
```bash
agent-browser eval "localStorage.setItem('sb-[PROJECT_ID]-auth-token', '[FULL_JSON_TOKEN]'); location.reload();"
```

## Step 3: Verify Login

After reload, check for authenticated UI elements:
- User avatar/initials instead of "Sign In"
- User menu instead of login button
- Protected routes accessible

## Example Token Format

The Supabase auth token looks like:
```json
{
  "access_token": "eyJ...",
  "token_type": "bearer",
  "expires_in": 3600,
  "expires_at": 1769105692,
  "refresh_token": "xxx",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "role": "authenticated",
    ...
  }
}
```

## Important Notes

1. **Token Expiry**: Tokens expire (usually 1 hour). Ask for fresh tokens if auth fails.

2. **GA4 OAuth is Separate**: Supabase auth ≠ Google Analytics access. The GA4 tokens are stored server-side in `google_auth_tokens` table, not in localStorage.

3. **Escape Quotes**: When injecting JSON, ensure proper escaping or use single quotes around the JSON string.

4. **Visible Mode**: Use `--headed` flag so user can see the browser state.

## App-Specific Keys (Cloud Connect Build)

| Key | Purpose |
|-----|---------|
| `sb-xxxxxxxxxxxxxxxxxxxxx-auth-token` | Supabase authentication |
| `theme` | Light/dark mode preference |
| `ga4-cro-report-favorites` | Favorited reports |
| `analytrix-last-viewed` | Last viewed report timestamps |
| `comparison-history` | Recent comparisons |

## Cloud Connect Build: Testing with Real GA4 Data

**Best Testing Page: /compare**

The Compare page (`/compare`) can load GA4 properties from the backend even without completing Google OAuth in the browser. After token injection:

1. Navigate to `/compare`
2. The page fetches GA4 properties from `ga4_properties` table via backend
3. Select properties to compare real analytics data
4. No additional OAuth flow needed in the test browser

This makes the Compare page the ideal location for testing with real GA4 data after authenticating via token injection.

## Token Format Requirements

When injecting the token via `agent-browser eval`:

1. **Single-line JSON**: The token must be on one line (no newlines)
2. **Escaped quotes**: Internal double quotes must be escaped as `\"`
3. **Outer single quotes**: Wrap the entire JSON in single quotes for the bash command

Example of properly formatted injection:
```bash
agent-browser eval "localStorage.setItem('sb-xxxxxxxxxxxxxxxxxxxxx-auth-token', '{\"access_token\":\"eyJ...\",\"token_type\":\"bearer\",\"user\":{\"id\":\"uuid\"}}'); location.reload();"
```
