---
description: Generate tasks from pre-built templates
argument-hint: "[TEMPLATE_NAME] [options]"
---

# Template Command

Generate tasks from pre-built patterns for common features.

## Usage

```bash
template list                    # Show available templates
template auth                    # Add authentication tasks
template crud users              # Add CRUD for "users" entity
template api /api/products       # Add API endpoint tasks
template component UserProfile   # Add component tasks
```

## Available Templates

| Template | Description | Tasks Generated |
|----------|-------------|-----------------|
| `auth` | Full authentication flow | 6-8 tasks |
| `crud [entity]` | CRUD operations for entity | 5 tasks |
| `api [endpoint]` | REST API endpoint | 4 tasks |
| `component [name]` | React component with tests | 3 tasks |
| `hook [name]` | Custom React hook | 2 tasks |
| `page [name]` | Full page with routing | 4 tasks |
| `supabase [table]` | Supabase table + RLS | 4 tasks |
| `edge-function [name]` | Supabase Edge Function | 3 tasks |

## Template Definitions

Templates are defined in `templates/task-patterns.json`. Each template has:
- `tasks[]` - Array of task definitions
- `variables` - Placeholders like `{{entity}}`
- `dependencies` - Which tasks block others

## Example: CRUD Template

```bash
template crud products
```

Generates:
```json
[
  { "id": "CRUD-01", "title": "Create products table schema", "blockedBy": [] },
  { "id": "CRUD-02", "title": "Add RLS policies for products", "blockedBy": ["CRUD-01"] },
  { "id": "CRUD-03", "title": "Create useProducts hook", "blockedBy": ["CRUD-02"] },
  { "id": "CRUD-04", "title": "Build ProductList component", "blockedBy": ["CRUD-03"] },
  { "id": "CRUD-05", "title": "Build ProductForm component", "blockedBy": ["CRUD-03"] }
]
```

## Custom Templates

Add custom templates to `.claude/templates/` in your project:

```json
// .claude/templates/my-pattern.json
{
  "name": "my-pattern",
  "description": "My custom workflow",
  "variables": ["name"],
  "tasks": [
    {
      "title": "Setup {{name}} infrastructure",
      "description": "...",
      "priority": 1,
      "files": ["src/{{name}}/index.ts"]
    }
  ]
}
```

## Integration with Brainstorm

Templates can be suggested during brainstorm:

```
User: I want to add user authentication
Claude: This matches the 'auth' template. Use it? (adds 6 pre-defined tasks)
```

## ID Prefix

Templates use prefixes to avoid conflicts:
- `AUTH-01`, `AUTH-02` for auth template
- `CRUD-01`, `CRUD-02` for crud template
- `API-01`, `API-02` for api template
