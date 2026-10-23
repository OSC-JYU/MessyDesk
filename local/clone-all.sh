#!/usr/bin/env bash
# Clones the repositories compose.yaml builds from, next to this repository (../..).
# Repositories that already exist are left alone.
#   ./clone-all.sh          base repositories
#   ./clone-all.sh --all    also MD-gensim and MD-Gliner2 (the optional compose profiles)
set -u

BASE=(
  MessyDesk-UI MD-consumers MD-sharp MD-poppler MD-pypdf_fs MD-zip_fs MD-text-base_fs
  MD-tesseract MD-docori MD-lingua MD-LibreTranslate
)
OPTIONAL=(MD-gensim MD-Gliner2)

repos=("${BASE[@]}")
[ "${1:-}" = "--all" ] && repos+=("${OPTIONAL[@]}")

parent="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
failed=()
for repo in "${repos[@]}"; do
  if [ -d "$parent/$repo" ]; then
    echo "ok       $repo (already there)"
  elif git clone --quiet "https://github.com/OSC-JYU/$repo.git" "$parent/$repo"; then
    echo "cloned   $repo"
  else
    echo "FAILED   $repo"
    failed+=("$repo")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "Could not clone: ${failed[*]}" >&2
  exit 1
fi
