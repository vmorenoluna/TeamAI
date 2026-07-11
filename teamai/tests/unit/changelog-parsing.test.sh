#!/usr/bin/env bash
# Test: CHANGELOG.md version-section extraction (awk logic used in release.yml)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHANGELOG="$SCRIPT_DIR/../../CHANGELOG.md"
PASS=0
FAIL=0

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label — expected '$needle' in output"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if ! echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label — unexpected '$needle' in output"
    FAIL=$((FAIL + 1))
  fi
}

# Helper: extract section for given version (same awk as release.yml)
extract_section() {
  local version="$1"
  local version_esc="${version//./\\.}"
  awk "/^## \\[${version_esc}\\]/{flag=1; print; next} /^## \\[/{flag=0} flag" "$CHANGELOG"
}

echo "=== CHANGELOG parsing tests ==="
echo ""

# ── Test 1: Extract 0.1.0 section ──────────────────────────────────────
echo "Test: Extract [0.1.0] section"
SECTION=$(extract_section "0.1.0")

assert_contains "heading present"     "$SECTION" "## [0.1.0]"
assert_contains "content line"        "$SECTION" "Kanban board"
assert_contains "Electron desktop"    "$SECTION" "Electron desktop app"
assert_not_contains "no other version heading" "$SECTION" "## [0.1.1]"
assert_not_contains "no unreleased heading"    "$SECTION" "## [Unreleased]"

# ── Test 2: No match for nonexistent version ────────────────────────────
echo ""
echo "Test: Extract nonexistent version returns empty"
EMPTY=$(extract_section "9.9.9")
if [ -z "$EMPTY" ]; then
  echo "  PASS: empty output"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected empty output, got: $EMPTY"
  FAIL=$((FAIL + 1))
fi

# ── Test 3: Extract [Unreleased] section ────────────────────────────────
echo ""
echo "Test: Extract [Unreleased] section"
UNRELEASED=$(extract_section "Unreleased")

assert_contains "heading present"    "$UNRELEASED" "## [Unreleased]"
assert_not_contains "no 0.1.0 heading" "$UNRELEASED" "## [0.1.0]"

# ── Summary ─────────────────────────────────────────────────────────────
echo ""
echo "=== $((PASS + FAIL)) tests: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
