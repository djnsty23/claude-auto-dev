# Context Management Skill

## Purpose
Manage hierarchical project knowledge in `context.json` for efficient context retrieval and pattern discovery.

## Commands

| Command | Action |
|---------|--------|
| `curate` | Extract patterns from code/docs into context.json |
| `query <domain>` | Retrieve context for specific domain |
| `context status` | Show context coverage |

## File: context.json
Located at project root, contains hierarchical project knowledge.

## Curate Workflow

When user says "curate":

### 1. Analyze Project Structure
```
Glob for: **/*.ts, **/*.tsx, **/*.json, **/*.md
Categorize by domain: backend, frontend, shared, devops
```

### 2. Extract Backend Context
```javascript
// Database
- Scan supabase/migrations/*.sql for schema
- Extract table names, columns, relationships
- Note RLS policies

// API
- Scan src/app/api/**/route.ts for endpoints
- Extract: method, path, params, response shape
- Note middleware patterns

// Auth
- Find auth strategy (Supabase Auth, NextAuth, custom)
- Document flows: signup, login, logout, refresh
- Note permission patterns
```

### 3. Extract Frontend Context
```javascript
// Components
- Scan src/components/**/*.tsx
- Note: props, state, hooks used
- Identify reusable vs one-off

// State
- Find state management (React Query, Zustand, Context)
- Document stores and query keys

// Routing
- Scan src/app/**/page.tsx
- Build route tree
```

### 4. Extract Shared Context
```javascript
// Types
- Scan src/types/**/*.ts
- Document main interfaces

// Utils
- Scan src/lib/**/*.ts
- Note utility functions

// Constants
- Find config files, enums, constants
```

### 5. Update context.json
```json
{
  "lastUpdated": "ISO timestamp",
  "domains": {
    "backend": {
      "database": {
        "schema": ["users", "reels", "profiles"],
        "migrations": ["001_initial", "002_add_reels"],
        "queries": ["/lib/supabase/hooks.ts"]
      },
      "api": {
        "endpoints": [
          { "method": "GET", "path": "/api/reels", "auth": true },
          { "method": "POST", "path": "/api/reels", "auth": true }
        ]
      }
    },
    "frontend": {
      "components": [
        { "name": "VideoPreview", "path": "src/components/video/VideoPreview.tsx" }
      ],
      "state": {
        "management": "react-query",
        "stores": ["useAuth", "useReels"]
      }
    }
  },
  "patterns": {
    "naming": { "components": "PascalCase", "hooks": "use*" },
    "errorHandling": "error boundaries + toast notifications"
  },
  "conventions": [
    "All API routes use Zod validation",
    "Components use shadcn/ui primitives"
  ]
}
```

## Query Workflow

When user says "query backend" or "query frontend":

### 1. Load Relevant Section
```
query backend.database → Load only database context
query frontend.components → Load only components
query auth → Load backend.auth context
```

### 2. Return Focused Context
Only include what's needed for the current task:
- If working on API: return endpoints + middleware
- If working on UI: return components + state
- If working on auth: return auth flows + permissions

### 3. Suggest Related Context
```
"You asked for backend.api. Related context available:
- backend.auth (for protected routes)
- frontend.state (for API hooks)"
```

## Context Status

When user says "context status":

```
Context Coverage Report
=======================
Last Updated: 2024-01-15 10:30:00

Backend:
  ✅ Database: 12 tables, 5 migrations
  ✅ API: 24 endpoints documented
  ⚠️  Auth: Needs update (last: 7 days ago)

Frontend:
  ✅ Components: 45 documented
  ✅ State: 8 stores
  ⚠️  Routing: 3 new routes not indexed

Shared:
  ✅ Types: 32 interfaces
  ❌ Utils: Not indexed

Recommendations:
- Run "curate" to update stale sections
- Auth section may have changed (check recent commits)
```

## Auto-Curate Triggers

Automatically suggest curation when:
1. New migration files detected
2. More than 5 new files since last curate
3. Major refactor completed
4. "context status" shows stale data

## Integration with Build System

### Pre-Task Context Loading
Before starting any task, build.md should:
1. Identify task domain (backend/frontend/etc)
2. Query relevant context
3. Include in task briefing

### Post-Task Context Update
After completing any task:
1. Check if new patterns emerged
2. Update conventions if needed
3. Mark context sections as potentially stale

## Context Tree Navigation

```
context.json
├── domains/
│   ├── backend/
│   │   ├── database/
│   │   │   ├── schema
│   │   │   ├── migrations
│   │   │   └── queries
│   │   ├── api/
│   │   │   ├── endpoints
│   │   │   ├── middleware
│   │   │   └── errorHandling
│   │   └── auth/
│   │       ├── strategy
│   │       ├── flows
│   │       └── permissions
│   ├── frontend/
│   │   ├── components
│   │   ├── state/
│   │   │   ├── management
│   │   │   └── stores
│   │   ├── routing
│   │   └── forms
│   └── shared/
│       ├── types
│       ├── utils
│       └── constants
├── patterns/
│   ├── naming
│   ├── fileStructure
│   ├── errorHandling
│   ├── validation
│   └── testing
├── conventions
├── knownIssues
└── decisions
```

## Example Usage

### Curating After New Feature
```
User: "curate"
Claude: Analyzing project structure...

Found changes since last curate:
- 3 new API routes in /api/youtube/
- 2 new components in /components/youtube/
- 1 new hook: useYouTubeVideoInfo

Updating context.json...

Updated:
✅ backend.api.endpoints (+3)
✅ frontend.components (+2)
✅ frontend.state.stores (+1)

Context is now up to date.
```

### Querying for Task
```
User: "query backend.api"
Claude: Loading API context...

Endpoints (24 total):
- GET /api/reels - List user reels (auth required)
- POST /api/reels - Create reel (auth required)
- GET /api/youtube/video - Fetch YouTube metadata (API key)
...

Patterns:
- All routes use Zod validation
- Error responses: { error: string, code?: string }
- Auth via Supabase middleware

Related: backend.auth, frontend.state
```
