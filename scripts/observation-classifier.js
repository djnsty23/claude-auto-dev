#!/usr/bin/env node
// observation-classifier.js — Classifies tool usage into typed observations
// Used by post-tool hook to auto-capture what Claude is doing

const path = require('path');

const VALID_TYPES = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'];

// Keywords that indicate specific observation types
const TYPE_KEYWORDS = {
    bugfix: /\b(fix|bug|error|crash|broken|issue|patch|hotfix|debug|resolve|repair)\b/i,
    refactor: /\b(refactor|restructure|reorganize|clean\s?up|simplify|extract|rename|move)\b/i,
    feature: /\b(add|create|implement|build|introduce|new|feature|enable|support)\b/i,
    discovery: /\b(investigate|explore|understand|analyze|research|check|inspect|diagnose|why|how)\b/i,
    decision: /\b(decide|choose|switch|migrate|replace|adopt|prefer|select|pick)\b/i,
};

/**
 * Classify a tool usage into an observation (or null to skip)
 *
 * @param {string} toolName - Name of the tool (Write, Edit, Bash, Read, Grep, Glob, etc.)
 * @param {object} toolInput - Input parameters passed to the tool
 * @param {string} toolResult - Result/output from the tool (may be truncated)
 * @param {string} userPrompt - The user's most recent prompt (for context)
 * @returns {object|null} - Observation object or null to skip
 */
function classifyObservation(toolName, toolInput, toolResult, userPrompt) {
    if (!toolName) return null;

    const prompt = (userPrompt || '').toLowerCase();
    const resultStr = (typeof toolResult === 'string' ? toolResult : '').slice(0, 500);

    switch (toolName) {
        case 'Write': {
            const filePath = toolInput?.file_path || toolInput?.path || '';
            const fileName = path.basename(filePath);
            const type = detectType(prompt, 'feature');
            return {
                type,
                title: `Created ${fileName}`,
                concept: extractConcept(prompt, `New file: ${filePath}`),
                sourceFiles: [filePath]
            };
        }

        case 'Edit': {
            const filePath = toolInput?.file_path || toolInput?.path || '';
            const fileName = path.basename(filePath);
            const type = detectType(prompt, 'change');
            const oldStr = (toolInput?.old_string || '').slice(0, 80);
            const newStr = (toolInput?.new_string || '').slice(0, 80);
            return {
                type,
                title: `${typeVerb(type)} ${fileName}`,
                concept: extractConcept(prompt, `${oldStr} → ${newStr}`),
                sourceFiles: [filePath]
            };
        }

        case 'Bash': {
            const cmd = toolInput?.command || '';

            // Skip trivial commands
            if (isTrivialBash(cmd)) return null;

            // Test runs
            if (/\b(test|jest|vitest|pytest|mocha|playwright|cypress)\b/i.test(cmd)) {
                const passed = !/\b(fail|error|FAIL|ERROR)\b/.test(resultStr);
                return {
                    type: 'discovery',
                    title: `Tests ${passed ? 'passed' : 'FAILED'}: ${cmd.slice(0, 50)}`,
                    concept: passed ? 'All tests passing' : `Test failures detected`,
                    sourceFiles: []
                };
            }

            // Git operations
            if (/\bgit\s+(commit|push|merge|rebase|cherry-pick)\b/.test(cmd)) {
                return {
                    type: 'change',
                    title: `Git: ${cmd.slice(0, 60)}`,
                    concept: extractConcept(prompt, 'Version control operation'),
                    sourceFiles: []
                };
            }

            // Package install
            if (/\b(npm|yarn|pnpm|pip|cargo)\s+(install|add|i)\b/.test(cmd)) {
                return {
                    type: 'change',
                    title: `Dependency: ${cmd.slice(0, 60)}`,
                    concept: 'Package installation',
                    sourceFiles: ['package.json']
                };
            }

            // Build/deploy
            if (/\b(build|deploy|vercel|netlify|docker)\b/i.test(cmd)) {
                return {
                    type: 'change',
                    title: `Build/Deploy: ${cmd.slice(0, 60)}`,
                    concept: extractConcept(prompt, 'Build or deployment operation'),
                    sourceFiles: []
                };
            }

            // Other significant commands
            if (cmd.length > 20) {
                return {
                    type: 'discovery',
                    title: `Ran: ${cmd.slice(0, 60)}`,
                    concept: resultStr.slice(0, 150) || 'Command execution',
                    sourceFiles: []
                };
            }

            return null;
        }

        case 'Read': {
            const filePath = toolInput?.file_path || '';
            // Only capture reads of significant files, not every file scan
            if (isSignificantRead(filePath)) {
                return {
                    type: 'discovery',
                    title: `Read ${path.basename(filePath)}`,
                    concept: `Investigated: ${filePath}`,
                    sourceFiles: [filePath]
                };
            }
            return null;
        }

        case 'Grep': {
            const pattern = toolInput?.pattern || '';
            const searchPath = toolInput?.path || '';
            return {
                type: 'discovery',
                title: `Searched for "${pattern.slice(0, 40)}"`,
                concept: `Code search in ${searchPath || 'project'}`,
                sourceFiles: searchPath ? [searchPath] : []
            };
        }

        // Skip Glob — too noisy
        case 'Glob':
            return null;

        default:
            return null;
    }
}

/**
 * Detect observation type from user prompt context
 */
function detectType(prompt, fallback) {
    for (const [type, regex] of Object.entries(TYPE_KEYWORDS)) {
        if (regex.test(prompt)) return type;
    }
    return fallback;
}

/**
 * Get a verb for the observation type (for titles)
 */
function typeVerb(type) {
    const verbs = {
        bugfix: 'Fixed',
        feature: 'Added',
        refactor: 'Refactored',
        change: 'Modified',
        discovery: 'Explored',
        decision: 'Decided on'
    };
    return verbs[type] || 'Updated';
}

/**
 * Extract a meaningful concept from context
 */
function extractConcept(prompt, fallback) {
    if (prompt && prompt.length > 5) {
        // Clean up and truncate prompt
        return prompt.slice(0, 200).trim();
    }
    return fallback;
}

/**
 * Filter out trivial bash commands that don't warrant observations
 */
function isTrivialBash(cmd) {
    const trivial = [
        /^\s*ls\b/,
        /^\s*pwd\b/,
        /^\s*echo\b/,
        /^\s*cat\b/,
        /^\s*head\b/,
        /^\s*tail\b/,
        /^\s*wc\b/,
        /^\s*which\b/,
        /^\s*whoami\b/,
        /^\s*date\b/,
        /^\s*cd\b/,
        /^\s*mkdir\b/,
        /^\s*rm\b/,
        /^\s*cp\b/,
        /^\s*mv\b/,
        /^\s*node\s+-[ev]\b/,  // Quick node evaluations
        /^\s*git\s+(status|log|diff|branch|show)\b/,  // Read-only git
        /^\s*git\s+stash\b/,
    ];
    return trivial.some(r => r.test(cmd));
}

/**
 * Determine if a file read is significant enough to track
 */
function isSignificantRead(filePath) {
    if (!filePath) return false;

    // Skip common config/meta files
    const skipPatterns = [
        /node_modules/,
        /\.git\//,
        /package-lock\.json/,
        /yarn\.lock/,
        /\.env/,
        /\.DS_Store/,
        /tsconfig\.json/,
        /\.eslintrc/,
        /\.prettierrc/,
    ];

    if (skipPatterns.some(r => r.test(filePath))) return false;

    // Track reads of source code, configs, and docs
    const significantExtensions = [
        '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.rb',
        '.md', '.json', '.yaml', '.yml', '.toml',
        '.sql', '.graphql', '.prisma',
        '.css', '.scss', '.html', '.svelte', '.vue',
    ];

    const ext = path.extname(filePath).toLowerCase();
    return significantExtensions.includes(ext);
}

module.exports = { classifyObservation, VALID_TYPES };
