#!/usr/bin/env bash
# Turns on this clone's safety locks. Run once, after cloning.
set -euo pipefail
cd "$(dirname "$0")"

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit 2>/dev/null || true

echo "hooks on: core.hooksPath = $(git config core.hooksPath)"
echo
echo "To test it: create a .js file that assigns a private key to a variable"
echo "and try to commit it. The hook must refuse."
echo
echo "This repository is PUBLIC. Nothing that needs a secret comes in here."
