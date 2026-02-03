---
description: Quick scan - verify tasks by file existence, mark complete
---

# Scan Command

Fast verification that marks tasks complete if their files exist.

## Usage

```
scan
```

## What It Does

1. Read prd.json
2. For each task with `passes: null`:
   - Check if ALL files in `files` array exist
   - If all exist AND files have content → mark `passes: true`
3. Report how many tasks were auto-completed

## Script

```javascript
const fs = require('fs');
const path = require('path');

const prd = JSON.parse(fs.readFileSync('prd.json', 'utf8'));
let completed = 0;

prd.stories.forEach(story => {
  if (story.passes !== null) return; // Skip done/failed

  const allFilesExist = story.files.every(file => {
    const filePath = file.startsWith('src/') || file.startsWith('supabase/')
      ? file
      : file;
    try {
      const stat = fs.statSync(filePath);
      return stat.size > 100; // Has meaningful content
    } catch {
      return false;
    }
  });

  if (allFilesExist && story.files.length > 0) {
    story.passes = true;
    completed++;
    console.log(`✓ ${story.id}: All ${story.files.length} files exist`);
  }
});

if (completed > 0) {
  fs.writeFileSync('prd.json', JSON.stringify(prd, null, 2));
  console.log(`\nMarked ${completed} tasks complete`);
} else {
  console.log('No tasks auto-completed (files missing or empty)');
}
```

## When to Use

- After parallel agents run from another session
- After manual file creation
- To quickly sync prd.json with actual codebase state

## Limitations

- Only checks file existence, not functionality
- Won't catch incomplete implementations
- Use `review` command for quality verification
