---
name: Setup Wizard
description: Interactive setup for API keys and configuration. Triggered by "setup", "configure", "api keys".
triggers:
  - setup
  - configure
  - api keys
  - setup api
---

# Setup Wizard

Interactive configuration for Claude Auto-Dev.

## On "setup" or "configure"

### Step 1: Welcome
Tell user:
```
Welcome to Claude Auto-Dev setup!

I'll help you configure API keys. You only need to set up the services you plan to use.
```

### Step 2: Ask Which Services

Use AskUserQuestion:
```
question: "Which services do you want to configure?"
multiSelect: true
options:
  - label: "Supabase"
    description: "Database & auth - Required for most projects"
  - label: "Google OAuth"
    description: "YouTube, Google login"
  - label: "AI Services"
    description: "ElevenLabs, OpenRouter, DeepSeek"
```

### Step 3: For Each Selected Service

#### If Supabase selected:
```
question: "Do you have a Supabase access token?"
options:
  - label: "Yes, I'll enter it"
    description: "I have my token ready"
  - label: "No, show me how"
    description: "I need to create one"
```

If "No, show me how":
```
1. Go to: https://supabase.com/dashboard/account/tokens
2. Click "Generate new token"
3. Name it "Claude Auto-Dev"
4. Copy the token (starts with sbp_)

Then say "setup" again when ready.
```

If "Yes":
```
question: "Paste your Supabase token (starts with sbp_)"
# User selects "Other" and pastes token
```

Then run:
```bash
# Windows
setx SUPABASE_ACCESS_TOKEN "sbp_..."

# Mac/Linux
echo 'export SUPABASE_ACCESS_TOKEN="sbp_..."' >> ~/.zshrc
```

#### If Google OAuth selected:
```
question: "Do you have Google OAuth credentials?"
options:
  - label: "Yes, I'll enter them"
    description: "I have Client ID and Secret"
  - label: "No, show me how"
    description: "I need to create them"
```

If "No, show me how":
```
1. Go to: https://console.cloud.google.com/apis/credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Add redirect URI: http://localhost:3000/api/auth/callback
4. Copy Client ID and Client Secret

Then say "setup" again when ready.
```

If "Yes", ask for each:
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET

#### If AI Services selected:
```
question: "Which AI services?"
multiSelect: true
options:
  - label: "ElevenLabs"
    description: "Voice synthesis - https://elevenlabs.io/api"
  - label: "OpenRouter"
    description: "Multi-model API - https://openrouter.ai/keys"
  - label: "DeepSeek"
    description: "Fast & cheap AI - https://platform.deepseek.com"
```

For each selected, ask for the API key and store it.

### Step 4: Verify & Complete

After storing all keys:
```bash
# Windows - verify
echo %SUPABASE_ACCESS_TOKEN%

# Mac/Linux - verify (need new terminal)
source ~/.zshrc && echo $SUPABASE_ACCESS_TOKEN
```

Tell user:
```
Setup complete!

Configured:
- ✅ SUPABASE_ACCESS_TOKEN
- ✅ GOOGLE_CLIENT_ID
- ✅ GOOGLE_CLIENT_SECRET

Note: Restart your terminal for changes to take effect.

Say "auto" to start working on tasks!
```

---

## Quick Links Reference

| Service | Get Key | Docs |
|---------|---------|------|
| Supabase | [Dashboard → Tokens](https://supabase.com/dashboard/account/tokens) | [Docs](https://supabase.com/docs) |
| Google OAuth | [Cloud Console](https://console.cloud.google.com/apis/credentials) | [Guide](https://developers.google.com/identity/protocols/oauth2) |
| ElevenLabs | [API Keys](https://elevenlabs.io/api) | [Docs](https://docs.elevenlabs.io) |
| OpenRouter | [Keys](https://openrouter.ai/keys) | [Docs](https://openrouter.ai/docs) |
| DeepSeek | [Platform](https://platform.deepseek.com) | [Docs](https://platform.deepseek.com/docs) |

---

## Adding New APIs

When implementing features that need new APIs, add them here:

### Template
```
#### If [ServiceName] selected:
Link: https://...
Steps:
1. Go to [link]
2. Create account / Navigate to API keys
3. Generate key
4. Copy (format: xxx_...)

Env var: SERVICE_API_KEY
```

### Example: Adding Stripe
```
#### If Stripe selected:
Link: https://dashboard.stripe.com/apikeys
Steps:
1. Go to https://dashboard.stripe.com/apikeys
2. Copy "Secret key" (starts with sk_)

Env var: STRIPE_SECRET_KEY
```

---

## Storage Commands

**Windows (persistent):**
```bash
setx VARIABLE_NAME "value"
```

**Mac/Linux (persistent):**
```bash
echo 'export VARIABLE_NAME="value"' >> ~/.zshrc
source ~/.zshrc
```

**Verify:**
```bash
# Windows
echo %VARIABLE_NAME%

# Mac/Linux
echo $VARIABLE_NAME
```
