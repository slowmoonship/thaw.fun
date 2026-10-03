#!/usr/bin/env bash
# Rebuild the pinned Platform CLI with the conversion-owner fix. This script
# only fetches source/dependencies, runs Go tests, and builds a local binary.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
deps_dir="$repo_root/.runtime/deps"
source_dir="$deps_dir/platform-cli-v2.0.1-owner-safe"
output_bin="$deps_dir/platform-cli-owner-safe"
patch_file="$repo_root/patches/platform-cli-v2.0.1-owner-safe.patch"
go_bin=${SHIPFUN_GO_BIN:-"$deps_dir/go1.26.7/bin/go"}
upstream_url=https://github.com/ava-labs/platform-cli.git
upstream_commit=bd8e858c46d57642b09c28300aa85dcd2ee9bf85
expected_sha256=c6e4c3fe5cea038b8ecd207cafe57a9c2f466b008957e652854bbd119ad654ba
offline=false
build_tmp=

fail() {
  printf 'owner-safe Platform CLI build: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$build_tmp" ]]; then
    rm -f "$build_tmp/platform-cli-owner-safe"
    rmdir "$build_tmp" 2>/dev/null || true
  fi
}
trap cleanup EXIT

case "${1:-}" in
  '') ;;
  --offline) offline=true ;;
  *) fail "usage: $0 [--offline]" ;;
esac
[[ $# -le 1 ]] || fail "usage: $0 [--offline]"

command -v git >/dev/null || fail 'git is required'
command -v shasum >/dev/null || fail 'shasum is required'
command -v cmp >/dev/null || fail 'cmp is required'
[[ -f "$patch_file" && ! -L "$patch_file" ]] || fail "missing or symlinked patch: $patch_file"
[[ -x "$go_bin" ]] || fail "Go 1.26.7 is required at $go_bin (or set SHIPFUN_GO_BIN)"
[[ "$("$go_bin" version)" == *'go1.26.7 darwin/arm64'* ]] || fail 'expected Go 1.26.7 on darwin/arm64'

mkdir -p "$deps_dir"
[[ ! -L "$source_dir" ]] || fail "source directory must not be a symlink: $source_dir"
if [[ ! -e "$source_dir" ]]; then
  [[ "$offline" == false ]] || fail 'source checkout is absent in --offline mode'
  printf 'Fetching pinned Platform CLI v2.0.1 source...\n'
  git clone --depth 1 --branch v2.0.1 -- "$upstream_url" "$source_dir"
fi
[[ -d "$source_dir/.git" ]] || fail "not a standalone Git checkout: $source_dir"
[[ "$(git -C "$source_dir" rev-parse --show-toplevel)" == "$source_dir" ]] || fail 'unexpected Git worktree root'
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$upstream_commit" ]] || fail 'upstream commit mismatch; refusing to patch or build'
git -C "$source_dir" diff --cached --quiet || fail 'source checkout has staged changes'
[[ -z "$(git -C "$source_dir" ls-files --others --exclude-standard)" ]] || fail 'source checkout has untracked files'

if git -C "$source_dir" diff --quiet; then
  git -C "$source_dir" apply --check "$patch_file" || fail 'patch does not apply cleanly to pinned source'
  git -C "$source_dir" apply "$patch_file"
  printf 'Applied tracked conversion-owner patch.\n'
fi
git -C "$source_dir" diff --no-ext-diff --binary | cmp -s "$patch_file" - || fail 'source changes differ from the tracked patch'

if [[ -e "$output_bin" ]]; then
  [[ -f "$output_bin" && ! -L "$output_bin" ]] || fail "unexpected binary path: $output_bin"
  existing_sha256=$(shasum -a 256 "$output_bin")
  [[ "${existing_sha256%% *}" == "$expected_sha256" ]] || fail 'existing binary hash differs; refusing to overwrite it'
fi

export GOTOOLCHAIN=local GOWORK=off GOTELEMETRY=off GOFLAGS= CGO_ENABLED=1
export GOMODCACHE="$deps_dir/go-mod-cache" GOCACHE="$deps_dir/go-build-cache"
if [[ "$offline" == true ]]; then
  export GOPROXY=off GOSUMDB=off
fi

printf 'Running the conversion-owner Go unit test...\n'
(cd "$source_dir" && "$go_bin" test -mod=readonly ./cmd -run '^TestSetConversionValidatorOwners$' -count=1)

build_tmp=$(mktemp -d "$deps_dir/platform-cli-owner-safe-build.XXXXXX")
printf 'Building darwin/arm64 Platform CLI...\n'
(cd "$source_dir" && "$go_bin" build -mod=readonly -o "$build_tmp/platform-cli-owner-safe" .)
actual_sha256=$(shasum -a 256 "$build_tmp/platform-cli-owner-safe")
[[ "${actual_sha256%% *}" == "$expected_sha256" ]] || fail "binary SHA-256 mismatch: ${actual_sha256%% *}"

if [[ ! -e "$output_bin" ]]; then
  ln "$build_tmp/platform-cli-owner-safe" "$output_bin" || fail 'binary appeared during build; refusing to overwrite it'
fi
printf 'Verified binary: %s\nSHA-256: %s\n' "$output_bin" "$expected_sha256"
