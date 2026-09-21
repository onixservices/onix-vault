#!/usr/bin/env bash
# Liga as travas de segurança deste clone. Correr uma vez, depois de clonar.
set -euo pipefail
cd "$(dirname "$0")"

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit 2>/dev/null || true

echo "hooks ligados: core.hooksPath = $(git config core.hooksPath)"
echo
echo "Para testar: crie um ficheiro .js com uma atribuicao de chave privada"
echo "e tente commitar. O hook tem de recusar."
echo
echo "Este repositório é PÚBLICO. Nada que precise de um segredo entra aqui."
