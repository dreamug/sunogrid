#!/usr/bin/env bash
set -Eeuo pipefail

# Run this on the server from the repository root:
#   ./release.sh
#
# Common overrides:
#   BRANCH=main SERVICE_NAME=sunogrid ./release.sh
#   HEALTHCHECK_URL=https://your-domain.example/api/health ./release.sh
#   RESTART_CMD='supervisorctl restart sunogrid-web' ./release.sh
#   RESTART_CMD='pm2 restart sunogrid' ./release.sh

IFS=$'\n\t'

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
WEB_DIR="${WEB_DIR:-$APP_DIR/web}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-sunogrid}"
PORT="${PORT:-}"
RUN_DB_MIGRATIONS="${RUN_DB_MIGRATIONS:-1}"
RUN_TYPECHECK="${RUN_TYPECHECK:-0}"
RUN_HEALTHCHECK="${RUN_HEALTHCHECK:-1}"
FORCE_RESET="${FORCE_RESET:-0}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"
RESTART_CMD="${RESTART_CMD:-}"
RESTARTED_SUPERVISOR_NAME=""

log() {
  printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

run() {
  log "$*"
  "$@"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

restart_app() {
  if [[ -n "$RESTART_CMD" ]]; then
    log "Restarting app with RESTART_CMD"
    bash -lc "$RESTART_CMD"
    return
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
    log "Restarting systemd service: $SERVICE_NAME"
    if [[ "$(id -u)" -eq 0 ]]; then
      systemctl restart "$SERVICE_NAME"
      systemctl --no-pager --full status "$SERVICE_NAME" || true
    else
      sudo systemctl restart "$SERVICE_NAME"
      sudo systemctl --no-pager --full status "$SERVICE_NAME" || true
    fi
    return
  fi

  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$SERVICE_NAME" >/dev/null 2>&1; then
    log "Restarting pm2 process: $SERVICE_NAME"
    pm2 restart "$SERVICE_NAME"
    return
  fi

  if command -v supervisorctl >/dev/null 2>&1; then
    supervisor_candidates=("$SERVICE_NAME")
    if [[ "$SERVICE_NAME" != *-web ]]; then
      supervisor_candidates+=("${SERVICE_NAME}-web")
    fi

    for supervisor_name in "${supervisor_candidates[@]}"; do
      if supervisorctl status "$supervisor_name" >/dev/null 2>&1; then
        log "Restarting supervisord program: $supervisor_name"
        supervisorctl restart "$supervisor_name"
        supervisorctl status "$supervisor_name" || true
        RESTARTED_SUPERVISOR_NAME="$supervisor_name"
        return
      fi
    done
  fi

  die "No restart target found. Install systemd/supervisord/pm2 target '$SERVICE_NAME', or set RESTART_CMD."
}

detect_supervisor_port() {
  [[ -n "$RESTARTED_SUPERVISOR_NAME" ]] || return 1
  command -v supervisorctl >/dev/null 2>&1 || return 1

  local pid
  pid="$(supervisorctl pid "$RESTARTED_SUPERVISOR_NAME" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1

  local value
  if [[ -r "/proc/$pid/environ" ]]; then
    value="$(tr '\0' '\n' <"/proc/$pid/environ" | awk -F= '$1 == "PORT" { print $2; exit }')"
    if [[ "$value" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  fi

  if [[ -r "/proc/$pid/cmdline" ]]; then
    local cmdline
    cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
    if [[ "$cmdline" =~ (^|[[:space:]])PORT=([0-9]+)($|[[:space:]]) ]]; then
      printf '%s\n' "${BASH_REMATCH[2]}"
      return 0
    fi
    if [[ "$cmdline" =~ (^|[[:space:]])-p[[:space:]]+([0-9]+)($|[[:space:]]) ]]; then
      printf '%s\n' "${BASH_REMATCH[2]}"
      return 0
    fi
    if [[ "$cmdline" =~ (^|[[:space:]])--port=([0-9]+)($|[[:space:]]) ]]; then
      printf '%s\n' "${BASH_REMATCH[2]}"
      return 0
    fi
    if [[ "$cmdline" =~ (^|[[:space:]])--port[[:space:]]+([0-9]+)($|[[:space:]]) ]]; then
      printf '%s\n' "${BASH_REMATCH[2]}"
      return 0
    fi
  fi

  return 1
}

resolve_healthcheck_urls() {
  if [[ -n "$HEALTHCHECK_URL" ]]; then
    printf '%s\n' "$HEALTHCHECK_URL"
    return
  fi

  if [[ -n "$PORT" ]]; then
    printf 'http://127.0.0.1:%s/api/health\n' "$PORT"
    return
  fi

  local detected_port
  detected_port="$(detect_supervisor_port || true)"
  if [[ -n "$detected_port" ]]; then
    printf 'http://127.0.0.1:%s/api/health\n' "$detected_port"
    return
  fi

  printf 'http://127.0.0.1:3000/api/health\n'
  printf 'http://127.0.0.1:3007/api/health\n'
}

healthcheck() {
  [[ "$RUN_HEALTHCHECK" == "1" ]] || return

  if ! command -v curl >/dev/null 2>&1; then
    log "Skipping healthcheck because curl is not installed"
    return
  fi

  local healthcheck_url
  while IFS= read -r healthcheck_url; do
    [[ -n "$healthcheck_url" ]] || continue
    log "Checking health: $healthcheck_url"
    if curl --fail --silent --show-error \
      --retry 12 --retry-delay 2 --retry-connrefused \
      "$healthcheck_url" >/dev/null; then
      return 0
    fi
  done < <(resolve_healthcheck_urls)

  die "Healthcheck failed. Set HEALTHCHECK_URL=https://your-domain/api/health or PORT=<actual-port> and retry."
}

need_cmd git
need_cmd node
need_cmd npm

cd "$APP_DIR"
[[ -d .git ]] || die "$APP_DIR is not a git repository"
[[ -d "$WEB_DIR" ]] || die "Web directory not found: $WEB_DIR"

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
[[ "$node_major" -ge 20 ]] || die "Node 20+ is required; current version is $(node -v)"

if [[ "$FORCE_RESET" != "1" ]]; then
  git diff --quiet || die "Working tree has local changes. Commit/stash them, or set FORCE_RESET=1 to discard server-side changes."
  git diff --cached --quiet || die "Index has staged changes. Commit/stash them, or set FORCE_RESET=1 to discard server-side changes."
fi

run git fetch --prune "$REMOTE"
remote_ref="$REMOTE/$BRANCH"
git rev-parse --verify "$remote_ref" >/dev/null || die "Remote branch not found: $remote_ref"
remote_head="$(git rev-parse "$remote_ref")"

if [[ "$FORCE_RESET" == "1" ]]; then
  run git switch -C "$BRANCH" "$remote_ref"
else
  current_branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$current_branch" != "$BRANCH" ]]; then
    log "Switching branch: $current_branch -> $BRANCH"
    if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
      git switch "$BRANCH"
    else
      git switch --track -c "$BRANCH" "$remote_ref"
    fi
  fi

  run git merge --ff-only "$remote_ref"

  if [[ "$(git rev-parse HEAD)" != "$remote_head" ]]; then
    die "Local HEAD differs from $remote_ref. Push/drop local server commits, or set FORCE_RESET=1 to deploy exactly $remote_ref."
  fi
fi

deploy_head="$(git rev-parse --short HEAD)"
log "Deploying $BRANCH@$deploy_head"

mkdir -p "$WEB_DIR/storage"

cd "$WEB_DIR"
if [[ ! -f .env ]]; then
  log "WARNING: $WEB_DIR/.env not found. DATABASE_URL must be available for Prisma and runtime."
fi

run npm ci

if [[ "$RUN_TYPECHECK" == "1" ]]; then
  run npm run typecheck
fi

run npm run build

if [[ "$RUN_DB_MIGRATIONS" == "1" ]]; then
  run npm run db:deploy
fi

restart_app
healthcheck

log "Release complete: $BRANCH@$deploy_head"
