#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Example: ./scripts/release.sh 0.2.0"
  exit 1
fi

# Strip leading 'v' if present
VERSION="${VERSION#v}"

# Validate semver-like format
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "❌ Invalid version: $VERSION (expected x.y.z)"
  exit 1
fi

echo "🏷️  Bumping to v$VERSION..."

# Update package.json
cd "$(dirname "$0")/../teamai"
node -e "
  const pkg = require('./package.json');
  const old = pkg.version;
  pkg.version = '$VERSION';
  require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log('  package.json: ' + old + ' → ' + pkg.version);
"

# Fold CHANGELOG.md's [Unreleased] section into a new [$VERSION] section,
# leaving [Unreleased] empty and ready for the next cycle. release.yml's
# release-notes step reads the "## [$VERSION]" heading this produces.
node -e "
  const fs = require('fs');
  const path = 'CHANGELOG.md';
  const version = '$VERSION';
  let content = fs.readFileSync(path, 'utf-8');
  const match = content.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/);
  if (!match) {
    console.log('  ⚠️  No [Unreleased] section found in CHANGELOG.md — skipping changelog fold');
  } else {
    const body = match[1].replace(/\n+$/, '');
    if (!body.trim()) {
      console.log('  ⚠️  [Unreleased] section is empty — skipping changelog fold (add entries before releasing)');
    } else {
      const today = new Date().toISOString().slice(0, 10);
      const replacement = '## [Unreleased]\n\n## [' + version + '] — ' + today + '\n' + body + '\n';
      content = content.replace(/## \[Unreleased\]\n[\s\S]*?(?=\n## \[|$)/, replacement);
      fs.writeFileSync(path, content);
      console.log('  CHANGELOG.md: [Unreleased] folded into [' + version + ']');
    }
  }
"

# Stage and commit
cd "$(dirname "$0")/.."
git add teamai/package.json teamai/CHANGELOG.md
git commit -m "chore: bump version to $VERSION" || echo "  (no changes to commit — version may already be $VERSION)"

# Create tag
git tag -a "v$VERSION" -m "v$VERSION"
echo "✅ Tag v$VERSION created"
echo ""
echo "Ready to push. Run:"
echo "  git push origin main && git push origin v$VERSION"
