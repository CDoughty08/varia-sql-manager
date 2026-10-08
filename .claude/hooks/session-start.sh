#!/usr/bin/env bash
# Prepares a Claude Code cloud session: a best-effort SQL Server container for the live checks, .NET 10 SDK,
# Node.js 24, npm packages, and backend builds. Local sessions are left untouched.
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
# SessionStart passes its source (startup, resume, clear, or compact) as JSON on stdin.
hook_source=$({ [ -t 0 ] || timeout 5 cat; } | grep -o '"source" *: *"[a-z]*"' | cut -d'"' -f4) || hook_source=''

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"
log_dir="${TMPDIR:-/tmp}/varia-session-start"
mkdir -p "$log_dir"
export DEBIAN_FRONTEND=noninteractive DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

say() { echo "session-start: $*"; }
fail() { echo "session-start: $*" >&2; exit 1; }
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }
# Tool output goes to a log so the session context only receives progress lines.
quiet() {
  local name=$1; shift
  if ! "$@" >"$log_dir/$name.log" 2>&1; then
    echo "session-start: $name failed; last lines of $log_dir/$name.log:" >&2
    tail -n 20 "$log_dir/$name.log" >&2
    return 1
  fi
}
persist() {
  [ -n "${CLAUDE_ENV_FILE:-}" ] || return 0
  grep -qxF "$1" "$CLAUDE_ENV_FILE" 2>/dev/null || echo "$1" >>"$CLAUDE_ENV_FILE"
}
node_major() { "${1:-node}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# A fixed development password: the container is disposable and published on loopback only.
sql_password='Varia_Dev_Pw1!'
start_sql() {
  command -v docker >/dev/null 2>&1 || { say 'Docker is not installed; live SQL checks will be skipped'; return 0; }
  if ! docker info >/dev/null 2>&1; then
    command -v dockerd >/dev/null 2>&1 || { say 'the Docker daemon is not running; live SQL checks will be skipped'; return 0; }
    say 'starting dockerd'
    # Detached with every stream redirected, so the daemon outlives the hook without holding its output open.
    as_root setsid dockerd >"$log_dir/dockerd.log" 2>&1 </dev/null &
    local daemon=$!
    for _ in $(seq 30); do
      docker info >/dev/null 2>&1 && break
      # A daemon that already exited (for example, for lack of privileges) will not answer later either.
      kill -0 "$daemon" 2>/dev/null || break
      sleep 1
    done
    docker info >/dev/null 2>&1 || { say "Docker did not start (see $log_dir/dockerd.log); live SQL checks will be skipped"; return 0; }
  fi
  if docker container inspect varia-sql >/dev/null 2>&1; then
    if [ "$(docker container inspect -f '{{.State.Running}}' varia-sql)" != true ]; then
      say 'starting the varia-sql container'
      quiet sql-start docker start varia-sql || { say 'the varia-sql container did not start; live SQL checks will be skipped'; return 0; }
    fi
  else
    say 'creating the varia-sql container (SQL Server 2022; the first image pull takes a few minutes)'
    quiet sql-create docker run -d --name varia-sql -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=$sql_password" -p 127.0.0.1:1433:1433 \
      mcr.microsoft.com/mssql/server:2022-latest || { say 'SQL Server could not be created; live SQL checks will be skipped'; return 0; }
  fi
  local probe='' deadline=$((SECONDS + 150))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if probe=$(docker exec varia-sql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$sql_password" -l 5 -b -Q 'SELECT 1' 2>&1); then
      persist 'export VARIA_TEST_SQL_SERVER=localhost'
      persist 'export VARIA_TEST_SQL_USER=sa'
      persist "export VARIA_TEST_SQL_PASSWORD='$sql_password'"
      say 'SQL Server is ready on localhost:1433; live SQL checks are enabled'
      return 0
    fi
    sleep 2
  done
  say "SQL Server in varia-sql is not ready; live SQL checks will be skipped. Last probe: $(printf '%s' "$probe" | tail -n 1)"
}
# First, so that a failed install or build later on cannot leave the live checks silently disabled.
start_sql || say 'SQL Server setup failed; live SQL checks will be skipped'

# dotnet-install.sh is blocked in cloud sessions; Ubuntu's archive carries the SDK.
if ! dotnet --list-sdks 2>/dev/null | grep -q '^10\.0\.'; then
  command -v apt-get >/dev/null 2>&1 || fail 'the .NET 10 SDK is missing and apt-get is unavailable to install it.'
  say 'installing the .NET 10 SDK from apt'
  quiet apt-update as_root apt-get update
  quiet apt-dotnet as_root apt-get install -y dotnet-sdk-10.0
fi

install_node() {
  local arch version base download="$log_dir/node-download"
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) fail "no Node.js build for $(uname -m)." ;; esac
  rm -rf "$download" && mkdir -p "$download"
  curl -fsSL --retry 3 -o "$download/index.json" https://nodejs.org/dist/index.json
  # index.json lists one release per line, newest first.
  version=$(grep -m 1 -o '"version":"v24\.[0-9]*\.[0-9]*"' "$download/index.json" | cut -d'"' -f4) || fail 'no Node.js 24 release found in index.json.'
  base="node-$version-linux-$arch"
  say "installing Node.js $version into /opt"
  curl -fsSL --retry 3 -o "$download/$base.tar.xz" "https://nodejs.org/dist/$version/$base.tar.xz"
  curl -fsSL --retry 3 -o "$download/SHASUMS256.txt" "https://nodejs.org/dist/$version/SHASUMS256.txt"
  (cd "$download" && grep " $base.tar.xz\$" SHASUMS256.txt | sha256sum -c --status) || fail "checksum mismatch for $base.tar.xz."
  [ ! -e /opt/node24 ] || [ -L /opt/node24 ] || fail '/opt/node24 exists and is not a symlink; remove it to install Node.js 24.'
  as_root tar --no-same-owner -xJf "$download/$base.tar.xz" -C /opt
  as_root ln -sfn "/opt/$base" /opt/node24
  rm -rf "$download"
}
if [ "$(node_major)" -lt 24 ]; then
  # Called as a statement, not after ||, so errexit still stops it at the first failed download or extraction.
  if [ "$(node_major /opt/node24/bin/node)" -lt 24 ]; then install_node; fi
  export PATH="/opt/node24/bin:$PATH"
  # shellcheck disable=SC2016 # $PATH expands when the session sources the environment file.
  persist 'export PATH=/opt/node24/bin:$PATH'
fi

ready() { say "ready: Node.js $(node --version), .NET SDK $(dotnet --version)"; }
# Clear and compact continue in the same container: the exports above are all they need, and reinstalling or
# rebuilding would only disturb work in progress.
case "$hook_source" in clear | compact) ready; exit 0 ;; esac

# npm install reuses the cached container's node_modules, unlike npm ci, but must not rewrite the lockfile.
cp package-lock.json "$log_dir/package-lock.json.orig"
say 'installing npm packages'
quiet npm-install npm install --no-audit --no-fund
if ! cmp -s package-lock.json "$log_dir/package-lock.json.orig"; then
  cp "$log_dir/package-lock.json.orig" package-lock.json
  fail 'npm install changed package-lock.json, so it disagrees with package.json. The lockfile was restored; reconcile it with npm install and commit the result.'
fi
# Electron downloads its binary on first launch; fetching it now keeps that out of the first smoke test.
quiet electron-install node node_modules/electron/install.js || say 'the Electron binary download failed; the smoke tests retry it on first launch'

say 'building the backend (Debug for npm run dev, Release for the smoke tests)'
# A failing build is usually work in progress, so it is reported without failing the session start.
quiet backend-debug npm run backend:build || say "the Debug backend build failed; see $log_dir/backend-debug.log"
quiet backend-release dotnet build backend/Varia.Backend/Varia.Backend.csproj --configuration Release ||
  say "the Release backend build failed; see $log_dir/backend-release.log"

ready
