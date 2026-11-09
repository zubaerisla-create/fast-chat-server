#!/usr/bin/env bash
# Staging deploy, installed at /opt/fast-chat-staging/deploy-staging.sh.
# Never touches /opt/fast-chat (production). Usable two ways:
#   - forced command for a staging-only CI key:  deploy <40-char git sha>
#     (stdin line 1: short-lived GHCR token, line 2: GitHub actor)
#   - manually on the server:  ./deploy-staging.sh deploy <40-char git sha>
#     (uses an image already present locally; no registry login)
set -euo pipefail

base=/opt/fast-chat-staging
project=fast-chat-staging
repo="zubaerisla-create/fast-chat-server"
cd "$base"

# Refuse to run against anything but the staging project
grep -qx "name: $project" docker-compose.yml || { echo "compose project is not $project" >&2; exit 2; }

read -r cmd sha extra <<< "${SSH_ORIGINAL_COMMAND:-$*}"
if [[ "${cmd:-}" != "deploy" || ! "${sha:-}" =~ ^[0-9a-f]{40}$ || -n "${extra:-}" ]]; then
  echo "usage: deploy <git-sha>" >&2
  exit 2
fi
image="ghcr.io/$repo:$sha"

if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  read -r token
  read -r actor
  [[ "$actor" =~ ^[A-Za-z0-9-]+$ ]] || { echo "bad actor" >&2; exit 2; }
  # Separate Docker config so the registry login never touches root's main config
  export DOCKER_CONFIG="$base/.docker"
  echo "$token" | docker login ghcr.io -u "$actor" --password-stdin >/dev/null
  docker pull -q "$image" >/dev/null
  docker logout ghcr.io >/dev/null
else
  docker image inspect "$image" >/dev/null 2>&1 || { echo "image $image not present locally" >&2; exit 1; }
fi

previous=$(grep -E '^API_IMAGE=' .env | cut -d= -f2- || true)
sed -i '/^API_IMAGE=/d' .env
echo "API_IMAGE=$image" >> .env

docker compose -p "$project" up -d --remove-orphans

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:5101/health >/dev/null; then
    echo "Staging deployed $sha — healthy"
    exit 0
  fi
  sleep 2
done

echo "Staging deploy of $sha is unhealthy; recent logs:" >&2
docker compose -p "$project" logs --tail 60 api >&2
if [[ -n "$previous" ]]; then
  echo "Rolling back to $previous" >&2
  sed -i '/^API_IMAGE=/d' .env
  echo "API_IMAGE=$previous" >> .env
  docker compose -p "$project" up -d api
fi
exit 1
