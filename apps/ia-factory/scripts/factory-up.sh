#!/usr/bin/env bash
# Starts the factory locally, after checking what it depends on.
#
# The factory needs three things to run: Docker (the sandboxes are local
# containers), an environment file (the API keys and the target repository),
# and a compiled app. This script checks the first two and starts the third.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! docker info > /dev/null 2>&1; then
  echo "Docker no está disponible. La fábrica usa contenedores locales para los sandboxes." >&2
  echo "Arranca Docker Desktop (o el daemon de Docker) y vuelve a intentarlo." >&2
  exit 1
fi

if [ ! -f .env.local ]; then
  echo "Falta .env.local. Copia .env.example y rellénalo." >&2
  exit 1
fi

if ! grep -q '^FACTORY_REPO=' .env.local; then
  echo "FACTORY_REPO no está en .env.local. La fábrica necesita saber sobre qué repositorio trabaja." >&2
  exit 1
fi

echo "Docker: listo."
echo "Repositorio: $(grep -m1 '^FACTORY_REPO=' .env.local | cut -d= -f2)"

exec pnpm exec eve dev "$@"
