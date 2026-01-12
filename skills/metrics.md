# Metrics Tracking Skill

## Purpose
Track development metrics in `metrics.json` for performance analysis and continuous improvement.

## Commands

| Command | Action |
|---------|--------|
| `metrics` | Show current metrics dashboard |
| `metrics reset` | Reset metrics (new project) |
| `metrics export` | Export metrics to markdown |

## File: metrics.json
Located at project root, contains tracking data.

## Metrics Dashboard

When user says "metrics":

```
REELR Development Metrics
=========================
Period: 2024-01-01 to 2024-01-15
Sessions: 23 | Total Tasks: 87

Task Performance
----------------
Completed:        82 (94%)
Failed:           5 (6%)
First-try success: 68 (78%)
Required rework:   14 (16%)

Testing
-------
Total tests:      156
Passed:          148 (95%)
Failed:            8 (5%)
Auto-fixed:        5

Efficiency
----------
Avg task time:    18 min
Avg test time:    4 min
Doom loops:       3
Pattern reuse:    24 times

Quality
-------
Hallucinations:   2
Correct first try: 78%
Build fixes:      12

Trend: ↑ Improving (vs last week)
```

## Automatic Tracking

### Session Start
```javascript
// Add to metrics.json
sessions.push({
  id: generateId(),
  startedAt: new Date().toISOString(),
  endedAt: null,
  tasksCompleted: 0,
  tasksFailed: 0,
  testsRun: 0,
  doomLoops: 0
});

tracking.totalSessions++;
```

### Task Completion
```javascript
// Update on task done
tasks.completed++;
tracking.totalTasks++;

if (firstTry) {
  tasks.firstTrySuccess++;
} else {
  tasks.requiredRework++;
}

// Update current session
currentSession.tasksCompleted++;
```

### Task Failure
```javascript
// Update on task failure
tasks.failed++;

// Check for doom loop
if (sameErrorRepeated(3)) {
  efficiency.doomLoopCount++;
  currentSession.doomLoops++;
}
```

### Test Run
```javascript
// Update after test suite
testing.totalTests += results.total;
testing.passed += results.passed;
testing.failed += results.failed;

if (autoFixed) {
  testing.autoFixed++;
}
```

### Session End
```javascript
// When user says "stop"
currentSession.endedAt = new Date().toISOString();

// Calculate averages
efficiency.avgTaskTime = calculateAverage(taskTimes);
efficiency.avgTestTime = calculateAverage(testTimes);
```

## Quality Metrics

### Hallucination Detection
Track when Claude:
- References non-existent files
- Uses incorrect API signatures
- Creates invalid imports

```javascript
quality.hallucinations++;
// Log in progress.txt
"[HALLUCINATION] Referenced non-existent file: src/lib/auth.ts"
```

### Build Success Rate
```javascript
// Track build results
if (buildFailed) {
  // After fix
  quality.buildsFailedThenFixed++;
}

if (buildSucceeded && firstTry) {
  quality.correctFirstTry++;
}
```

## Pattern Reuse Tracking

When a known pattern is applied:

```javascript
// From patterns.json
if (usingPattern(task)) {
  efficiency.patternReuseCount++;

  // Update pattern usage count
  patterns.successfulPatterns.find(p => p.id === patternId).usageCount++;
}
```

## Metrics Export

When user says "metrics export":

```markdown
# Development Metrics Report

## Overview
- **Project:** REELR
- **Period:** January 1-15, 2024
- **Total Sessions:** 23
- **Total Tasks:** 87

## Task Performance

| Metric | Count | Percentage |
|--------|-------|------------|
| Completed | 82 | 94% |
| Failed | 5 | 6% |
| First-try | 68 | 78% |
| Rework | 14 | 16% |

## Testing Summary

| Metric | Count |
|--------|-------|
| Total Tests | 156 |
| Passed | 148 (95%) |
| Failed | 8 (5%) |
| Auto-fixed | 5 |

## Efficiency Insights

- Average task completion: 18 minutes
- Doom loops encountered: 3
- Patterns reused: 24 times
- Most used pattern: "Zod-first API design" (12x)

## Quality Indicators

- Hallucinations: 2 (0.02/task)
- Build fixes required: 12
- First-try success rate: 78%

## Recommendations

Based on metrics analysis:
1. Doom loops are low - awareness system working
2. First-try rate improving - pattern reuse helps
3. Consider adding tests for edge cases (5% failure)
```

## Trend Analysis

Compare current period to previous:

```javascript
function analyzeTrends() {
  const current = getCurrentPeriodMetrics();
  const previous = getPreviousPeriodMetrics();

  return {
    taskSuccess: compareRate(current.tasks.completed, previous.tasks.completed),
    firstTryRate: compareRate(current.tasks.firstTrySuccess, previous.tasks.firstTrySuccess),
    testPassRate: compareRate(current.testing.passed, previous.testing.passed),
    doomLoops: compareDelta(current.efficiency.doomLoopCount, previous.efficiency.doomLoopCount),
    overall: calculateOverallTrend()
  };
}

// Display
"Trend: ↑ Improving" | "Trend: → Stable" | "Trend: ↓ Needs attention"
```

## Integration Points

### With Build System
```javascript
// In build.md task loop
onTaskStart() {
  taskStartTime = Date.now();
}

onTaskComplete(success) {
  const duration = Date.now() - taskStartTime;
  updateMetrics({ type: 'task', success, duration });
}
```

### With Awareness System
```javascript
// Doom loop detection feeds metrics
onDoomLoopDetected() {
  metrics.efficiency.doomLoopCount++;
  // Also triggers awareness.md intervention
}
```

### With Learning System
```javascript
// Pattern reuse tracking
onPatternApplied(patternId) {
  metrics.efficiency.patternReuseCount++;
  patterns.successfulPatterns[patternId].usageCount++;
}
```

## Session Structure

```json
{
  "sessions": [
    {
      "id": "sess_20240115_001",
      "startedAt": "2024-01-15T09:00:00Z",
      "endedAt": "2024-01-15T12:30:00Z",
      "tasksCompleted": 5,
      "tasksFailed": 0,
      "testsRun": 23,
      "testsPassed": 22,
      "doomLoops": 0,
      "patternsUsed": ["SP001", "SP003"],
      "notes": "Completed YouTube import feature"
    }
  ]
}
```

## Alerts

Trigger alerts when:

```javascript
// Quality degradation
if (tasks.failed / tasks.completed > 0.2) {
  alert("⚠️ High failure rate (>20%) - review recent approaches");
}

// Doom loop spike
if (efficiency.doomLoopCount > previousPeriod * 1.5) {
  alert("⚠️ Doom loops increasing - check awareness patterns");
}

// Test coverage drop
if (testing.passed / testing.totalTests < 0.9) {
  alert("⚠️ Test pass rate below 90% - investigate failures");
}
```

## Reset Metrics

When user says "metrics reset":

```
This will reset all metrics to zero.
Use this when starting a new project phase.

Are you sure? (y/n)

[If yes]
✅ Metrics reset. Previous data archived to metrics.2024-01-15.json
```
