#!/usr/bin/env bash
# Push this directory to the paws-demo GitHub repo.
# Linear issues are reset by scripts/demo-reset.ts in the Paws checkout.
set -euo pipefail

if [[ "${1:-}" != "--yes" ]]; then
  echo "Refusing to push without --yes. This force-pushes main on the paws-demo repo." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${PAWS_DEMO_REPO:-pmdroid/paws-demo}"

if [[ ! "$REPO" =~ ^[A-Za-z0-9._-]+/paws-demo$ ]]; then
  echo "Refusing to push to ${REPO}. The repo name must be paws-demo." >&2
  exit 2
fi

if ! gh repo view "$REPO" --json name >/dev/null 2>&1; then
  gh repo create "$REPO" --private --description "Smoke demo for Paws" --disable-wiki
fi

WORKDIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

tar -C "$ROOT" \
  --exclude node_modules \
  --exclude .git \
  --exclude .closeout \
  -cf - . | tar -C "$WORKDIR" -xf -

git -C "$WORKDIR" init -b main >/dev/null
git -C "$WORKDIR" add -A
git -C "$WORKDIR" \
  -c user.name="Paws Demo" \
  -c user.email="paws-demo@users.noreply.github.com" \
  commit -m "Reset the paws demo template" >/dev/null

TOKEN="$(gh auth token)"
HELPER="${WORKDIR}/cred.sh"
cat >"$HELPER" <<'EOF'
#!/bin/sh
if [ "$1" = "get" ]; then
  printf 'username=x-access-token\n'
  printf 'password=%s\n' "$PAWS_DEMO_GITHUB_TOKEN"
fi
EOF
chmod 700 "$HELPER"

PAWS_DEMO_GITHUB_TOKEN="$TOKEN" \
  GIT_TERMINAL_PROMPT=0 \
  git -C "$WORKDIR" \
  -c credential.helper= \
  -c "credential.helper=${HELPER}" \
  push --force "https://github.com/${REPO}.git" HEAD:main

echo "Pushed ${ROOT} to ${REPO} main"
