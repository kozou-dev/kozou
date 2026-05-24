#!/usr/bin/env bash
# scripts/check-english-only.sh
#
# Fail if any git-tracked file in the kozou (public OSS) repo contains
# characters from a major non-Latin script. This is a defense-in-depth
# check against autonomous AI agents (or hurried contributors)
# accidentally introducing non-English text into a globally-oriented
# OSS project.
#
# The goal is "don't silently land non-English text", not "ban any
# specific language". We screen for the major non-Latin scripts that
# tend to leak in from quoted prompts, sample data, or pasted comments;
# we do NOT block Latin diacritics (é, ü, ñ, ø, ç, ...) because they
# are common in English loanwords and contributor names.
#
# Scripts blocked:
#   - Hiragana          (Japanese phonetic)
#   - Katakana          (Japanese phonetic)
#   - Han               (CJK ideographs: Chinese, Japanese kanji,
#                        Korean hanja - covers CJK Unified +
#                        Extension A / B+ / Compatibility)
#   - Hangul            (Korean)
#   - Cyrillic          (Russian, Ukrainian, Serbian, ...)
#   - Arabic            (Arabic, Persian, Urdu, ...)
#   - Hebrew            (Hebrew, Yiddish)
#   - Devanagari        (Hindi, Sanskrit, Marathi, ...)
#   - Thai              (Thai)
#
# Not blocked (intentionally):
#   - Latin diacritics  (Latin-1 Supplement, Latin Extended-A/B):
#                        é, ü, ñ, ø, ç, ä, æ, œ, ß, ...
#   - Greek             (used in math notation: α, β, π, Δ, ∑, ...)
#   - Currency / math   (€, £, ¥, ∞, ≠, ≤, ≥, ...)
#
# If a future contribution legitimately needs additional non-Latin
# script support, propose updating both the regex below and the
# language-policy section of AGENTS.md in the same PR.
#
# Why perl, not grep -P:
#   The default `grep` on macOS (BSD grep) does not support the -P
#   (Perl-compatible regex) flag. `perl -CSDA` is available on every
#   reasonable Unix host (macOS ships with it) and supports Unicode
#   property classes out of the box.
#
# Excluded file kinds:
#   - Binary blobs that may legitimately contain non-Latin bytes
#     inside compressed payloads: png/jpg/gif/svg/ico/woff/ttf/otf/
#     pdf/zip/gz/tar/lock
#
# Run locally:
#   bash scripts/check-english-only.sh
#
# Used by CI in `.github/workflows/license-check.yml` to gate every
# push and PR.

set -euo pipefail

# Resolve the repo root from the script's own location so this works no
# matter where the caller is when they invoke the script (e.g. from a
# parent symlink dir, from a CI runner with a custom cwd, etc.).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# Collect tracked files, excluding binary kinds.
files=$(git ls-files | grep -v -E '\.(png|jpg|gif|svg|ico|woff|ttf|otf|pdf|zip|gz|tar|lock)$' || true)

if [ -z "$files" ]; then
  echo "OK: no tracked files to scan"
  exit 0
fi

# Scan each file for blocked scripts; emit file:line:content for any
# hit so CI logs point straight at the offending location.
hits=$(printf '%s\n' "$files" | while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  perl -CSDA -ne '
    if (/\p{Hiragana}|\p{Katakana}|\p{Han}|\p{Hangul}|\p{Cyrillic}|\p{Arabic}|\p{Hebrew}|\p{Devanagari}|\p{Thai}/) {
      print "$ARGV:$.:$_";
    }
  ' "$f" || true
done)

if [ -n "$hits" ]; then
  echo "ERROR: non-English text found in tracked files:"
  printf '%s\n' "$hits"
  echo ""
  echo "The kozou public repo is English-only. Move the affected"
  echo "content to the private companion repo, or rewrite it in"
  echo "English. See the language-policy section of AGENTS.md for"
  echo "the full policy and the list of blocked scripts."
  exit 1
fi

echo "OK: no non-English text in tracked files"
