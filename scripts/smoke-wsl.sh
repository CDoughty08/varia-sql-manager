#!/usr/bin/env bash
# The Linux half of scripts/smoke-wsl.mjs, which runs it through wsl.exe one phase at a time. Not meant to be run by hand.
#
#   setup                           installs Node 24 and the .NET SDK from global.json under $VARIA_WSL_HOME
#   prepare <git-dir> <sha> <ref>   syncs the clone to <sha>, runs npm ci when package-lock.json changed, npm run build:smoke
#   suites <script>...              runs each suite under xvfb-run, all of them even after one fails
#
# The clone ($VARIA_WSL_CLONE) lives on the Linux filesystem: node_modules, Electron and the backend build must be
# Linux-native, and /mnt/c is far slower. Nothing here prints environment values.
set -euo pipefail

home="${VARIA_WSL_HOME:-$HOME/.varia-wsl}"
clone="${VARIA_WSL_CLONE:-$home/clone}"
node_dir="$home/node"
dotnet_dir="$home/dotnet"
export DOTNET_ROOT="$dotnet_dir" DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
export PATH="$node_dir/bin:$dotnet_dir:$PATH"

say() { printf '[smoke-wsl] %s\n' "$*"; }
fail() { printf '[smoke-wsl] %s\n' "$*" >&2; exit 1; }

missing_toolchain() {
  [[ -x "$node_dir/bin/node" ]] || return 0
  [[ "$("$node_dir/bin/node" -p 'process.versions.node.split(".")[0]')" -ge 24 ]] || return 0
  [[ -x "$dotnet_dir/dotnet" ]] || return 0
  return 1
}

setup() {
  local repo="$PWD" tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$home"
  say "Installing Node 24 into $node_dir"
  local base='https://nodejs.org/dist/latest-v24.x'
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  local tarball
  tarball="$(grep -oE 'node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz' "$tmp/SHASUMS256.txt" | head -n 1)"
  [[ -n "$tarball" ]] || fail 'Could not find the Node 24 linux-x64 tarball in SHASUMS256.txt.'
  curl -fsSL "$base/$tarball" -o "$tmp/$tarball"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c --quiet -) || fail "Checksum mismatch for $tarball."
  rm -rf "$node_dir" && mkdir -p "$node_dir"
  tar -xJf "$tmp/$tarball" -C "$node_dir" --strip-components=1
  say "Installing the .NET SDK from global.json into $dotnet_dir"
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$tmp/dotnet-install.sh"
  bash "$tmp/dotnet-install.sh" --jsonfile "$repo/global.json" --install-dir "$dotnet_dir" --no-path
  say "node $(node --version), dotnet $(dotnet --version)"
  command -v xvfb-run > /dev/null || say 'xvfb-run is missing: run  sudo apt-get install -y xvfb'
  dpkg -s libgssapi-krb5-2 > /dev/null 2>&1 || say 'libgssapi-krb5-2 is missing (the backend needs it): run  sudo apt-get install -y libgssapi-krb5-2'
}

prepare() {
  local git_dir sha="$2" ref="$3"
  git_dir="$(wslpath -u "$1")"
  missing_toolchain && fail 'The WSL toolchain is missing: run  npm run test:smoke:wsl -- --setup  first.'
  if [[ ! -d "$clone/.git" ]]; then
    say "Creating the Linux clone in $clone"
    mkdir -p "$clone" && git -C "$clone" init -q
  fi
  # A Windows checkout's files look foreign-owned to Linux git, and the snapshot commit is not on any ref, so the
  # upload-pack on the Windows side is allowed to serve it by id.
  say "Fetching $ref (${sha:0:12})"
  git -C "$clone" -c protocol.file.allow=always fetch -q --no-tags \
    --upload-pack="git -c safe.directory=* -c uploadpack.allowAnySHA1InWant=true upload-pack" "$git_dir" "$sha"
  git -C "$clone" checkout -q --force --detach "$sha"
  # Untracked files the snapshot does not have; ignored build output (node_modules, bin/obj, out/) stays for speed.
  git -C "$clone" clean -q -fd
  cd "$clone"
  local hash stamp=node_modules/.varia-smoke-wsl-lock
  hash="$(sha256sum package-lock.json | cut -d' ' -f1)"
  if [[ ! -f "$stamp" || "$(cat "$stamp")" != "$hash" ]]; then
    say 'package-lock.json changed: npm ci'
    npm ci --no-audit --no-fund
    printf '%s\n' "$hash" > "$stamp"
  else
    say 'package-lock.json unchanged: skipping npm ci'
  fi
  say 'npm run build:smoke'
  npm run build:smoke
}

suites() {
  missing_toolchain && fail 'The WSL toolchain is missing: run  npm run test:smoke:wsl -- --setup  first.'
  command -v xvfb-run > /dev/null || fail 'xvfb-run is missing: run  sudo apt-get install -y xvfb'
  cd "$clone"
  [[ -d out ]] || fail "No build in $clone: run without --no-build first."
  local failed=() suite start code
  for suite in "$@"; do
    say "Running $suite"
    start=$SECONDS
    code=0
    xvfb-run -a -s '-screen 0 1600x1000x24' node "$suite" || code=$?
    say "$suite exited $code after $((SECONDS - start)) s"
    [[ $code -eq 0 ]] || failed+=("$suite")
  done
  if [[ ${#failed[@]} -gt 0 ]]; then
    say "Failed on Linux: ${failed[*]}"
    exit 1
  fi
  say "Passed on Linux: $*"
}

phase="${1:-}"
shift || true
case "$phase" in
  setup) setup "$@" ;;
  prepare) prepare "$@" ;;
  suites) suites "$@" ;;
  *) fail "Unknown phase '$phase'." ;;
esac
