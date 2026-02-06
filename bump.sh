#!/bin/bash
# bump.sh - Version bumper for claude-auto-dev
# Usage: bash bump.sh <new-version>
# Updates version in all sync points

set -e

NEW_VERSION="$1"
if [ -z "$NEW_VERSION" ]; then
    echo "Usage: bash bump.sh <new-version>"
    echo "Current: $(cat VERSION)"
    exit 1
fi

OLD_VERSION=$(cat VERSION)
echo "Bumping $OLD_VERSION → $NEW_VERSION"
echo ""

# 1. VERSION file
echo "$NEW_VERSION" > VERSION

# 2. package.json (x.y → x.y.0)
SEMVER="${NEW_VERSION}.0"
node -e "
const pkg = require('./package.json');
pkg.version = '$SEMVER';
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# 3. manifest.json
node -e "
const m = require('./skills/manifest.json');
m.version = '$NEW_VERSION';
require('fs').writeFileSync('skills/manifest.json', JSON.stringify(m, null, 2) + '\n');
"

# 4. README.md — update badge
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS
  sed -i '' "s/v${OLD_VERSION}/v${NEW_VERSION}/g" README.md
else
  # Linux/Git Bash
  sed -i "s/v${OLD_VERSION}/v${NEW_VERSION}/g" README.md
fi

# 5. CHANGELOG.md — don't auto-add, just remind
echo "[Note] Add ## [$NEW_VERSION] section to CHANGELOG.md manually"

# 6. commands.md
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/(v${OLD_VERSION})/(v${NEW_VERSION})/g" skills/commands.md
else
  sed -i "s/(v${OLD_VERSION})/(v${NEW_VERSION})/g" skills/commands.md
fi

# 7. install.sh
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/v${OLD_VERSION}/v${NEW_VERSION}/g" install.sh
  sed -i '' "s/\"${OLD_VERSION}\"/\"${NEW_VERSION}\"/g" install.sh
else
  sed -i "s/v${OLD_VERSION}/v${NEW_VERSION}/g" install.sh
  sed -i "s/\"${OLD_VERSION}\"/\"${NEW_VERSION}\"/g" install.sh
fi

# 8. install.ps1
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/v${OLD_VERSION}/v${NEW_VERSION}/g" install.ps1
  sed -i '' "s/\"${OLD_VERSION}\"/\"${NEW_VERSION}\"/g" install.ps1
else
  sed -i "s/v${OLD_VERSION}/v${NEW_VERSION}/g" install.ps1
  sed -i "s/\"${OLD_VERSION}\"/\"${NEW_VERSION}\"/g" install.ps1
fi

# 9. session-start.js fallback version
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/version = '${OLD_VERSION}'/version = '${NEW_VERSION}'/g" hooks/session-start.js
else
  sed -i "s/version = '${OLD_VERSION}'/version = '${NEW_VERSION}'/g" hooks/session-start.js
fi

echo ""
echo "Updated $NEW_VERSION in:"
echo "  VERSION, package.json, manifest.json, README.md,"
echo "  commands.md, install.sh, install.ps1, session-start.js"
echo ""
echo "Manual steps:"
echo "  1. Add ## [$NEW_VERSION] section to CHANGELOG.md"
echo "  2. Run: node validate.js"
echo "  3. Commit and tag: git tag v$NEW_VERSION"
