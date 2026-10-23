#!/usr/bin/env bash
# Forced command for the GitHub Actions deploy key (see authorized_keys on the VPS).
# The key can only run:   deploy <40-char git sha>
# stdin line 1: short-lived GHCR token, line 2: GitHub actor.
set -euo pipefail
cd /opt/fast-chat

read -r cmd sha extra <<< "${SSH_ORIGINAL_COMMAND:-}"
if [[ "${cmd:-}" != "deploy" || ! "${sha:-}" =~ ^[0-9a-f]{40}$ || -n "${extra:-}" ]]; then
  echo "usage: deploy <git-sha>" >&2
  exit 2
fi
read -r token
read -r actor
[[ "$actor" =~ ^[A-Za-z0-9-]+$ ]] || { echo "bad actor" >&2; exit 2; }

repo="zubaerisla-create/fast-chat-server"
curl -fsSL "https://raw.githubusercontent.com/$repo/$sha/deploy/docker-compose.yml" -o docker-compose.yml.new
mv docker-compose.yml.new docker-compose.yml

# Separate Docker config so the registry login never touches root's main config
export DOCKER_CONFIG=/opt/fast-chat/.docker
echo "$token" | docker login ghcr.io -u "$actor" --password-stdin >/dev/null

previous=$(grep -E '^API_IMAGE=' .env | cut -d= -f2- || true)
sed -i '/^API_IMAGE=/d' .env
echo "API_IMAGE=ghcr.io/$repo:$sha" >> .env

docker compose pull api
docker compose up -d --remove-orphans
docker logout ghcr.io >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:5100/health >/dev/null; then
    echo "Deployed $sha — healthy"
    exit 0
  fi
  sleep 2
done

echo "Deploy of $sha is unhealthy; recent logs:" >&2
docker compose logs --tail 60 api >&2
if [[ -n "$previous" ]]; then
  echo "Rolling back to $previous" >&2
  sed -i '/^API_IMAGE=/d' .env
  echo "API_IMAGE=$previous" >> .env
  docker compose up -d api
fi
exit 1
