#!/bin/sh
set -eu

base=${PAWS_RUNNER_DOWNLOAD_BASE:-https://github.com/pmdroid/paws-app/releases}

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

usage() {
  printf '%s\n' "Usage: curl -fsSL https://get.paws.boo | sudo sh -s -- [--docker-access | --no-docker-access] [version]"
}

semver_ok() {
  case $1 in
    *[!0-9.]*) return 1 ;;
  esac
  saved_ifs=$IFS
  IFS=.
  set -f
  set -- $1
  set +f
  IFS=$saved_ifs
  [ $# -eq 3 ] || return 1
  for part do
    case $part in
      0|[1-9]|[1-9][0-9]*) ;;
      *) return 1 ;;
    esac
  done
}

normalize_version() {
  tag=$1
  case $tag in
    v*) tag=${tag#v} ;;
  esac
  semver_ok "$tag" || return 1
  printf '%s\n' "$tag"
}

fetch() {
  pinned=1
  if [ -n "${PAWS_RUNNER_DOWNLOAD_BASE:-}" ]; then
    case $PAWS_RUNNER_DOWNLOAD_BASE in
      http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*)
        if [ "${PAWS_RUNNER_ALLOW_HTTP_BASE:-}" != 1 ]; then
          die "Refusing a non-HTTPS download base"
        fi
        pinned=0
        ;;
      https://*)
        ;;
      *)
        die "Download base must use https"
        ;;
    esac
  fi
  if [ "$pinned" -eq 0 ]; then
    curl -fsSL --retry 3 --retry-delay 1 "$@"
  else
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 1 "$@"
  fi
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

architecture() {
  arch=""
  if command -v dpkg >/dev/null 2>&1; then
    arch=$(dpkg --print-architecture)
  fi
  if [ -z "$arch" ]; then
    case $(uname -m) in
      x86_64) arch=amd64 ;;
      aarch64|arm64) arch=arm64 ;;
      *) die "Unsupported machine: $(uname -m)" ;;
    esac
  fi
  case $arch in
    amd64|arm64) printf '%s\n' "$arch" ;;
    *) die "Unsupported architecture: $arch" ;;
  esac
}

requested=""
docker_access=""
for argument do
  case $argument in
    -h|--help)
      usage
      exit 0
      ;;
    --docker-access|--no-docker-access)
      choice=grant
      [ "$argument" = --docker-access ] || choice=deny
      if [ -n "$docker_access" ] && [ "$docker_access" != "$choice" ]; then
        die "Pass only one of --docker-access and --no-docker-access"
      fi
      docker_access=$choice
      ;;
    --version=*)
      [ -z "$requested" ] || { usage >&2; exit 1; }
      requested=${argument#--version=}
      ;;
    -*)
      usage >&2
      exit 1
      ;;
    *)
      [ -z "$requested" ] || { usage >&2; exit 1; }
      requested=$argument
      ;;
  esac
done
if [ -z "$docker_access" ] && [ -n "${PAWS_RUNNER_DOCKER_ACCESS:-}" ]; then
  case $PAWS_RUNNER_DOCKER_ACCESS in
    grant|deny) docker_access=$PAWS_RUNNER_DOCKER_ACCESS ;;
    *) die "PAWS_RUNNER_DOCKER_ACCESS must be grant or deny" ;;
  esac
fi
if [ -z "$requested" ] && [ -n "${PAWS_RUNNER_VERSION:-}" ]; then
  requested=$PAWS_RUNNER_VERSION
fi

version=""
if [ -n "$requested" ]; then
  version=$(normalize_version "$requested") || die "Version must look like 1.2.3"
fi

if [ "$(id -u)" -ne 0 ]; then
  if [ -n "$requested" ]; then
    die "Run the installer as root: curl -fsSL https://get.paws.boo | sudo sh -s -- ${requested}"
  fi
  die "Run the installer as root: curl -fsSL https://get.paws.boo | sudo sh"
fi

need curl
need sha256sum
need apt-get
arch=$(architecture)

if [ -z "$version" ]; then
  if ! effective=$(fetch -o /dev/null -w '%{url_effective}' "${base}/latest"); then
    die "Could not resolve the latest runner release"
  fi
  tag=${effective%/}
  tag=${tag##*/}
  tag=${tag%%\?*}
  version=$(normalize_version "$tag") || die "Latest release tag is not a runner version"
fi

name="paws-runner_${version}_${arch}.deb"
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
cd "$workdir"

downloaded=""
for tag in "v${version}" "$version"; do
  package_url="${base}/download/${tag}/${name}"
  if fetch -o "$name" "$package_url" && fetch -o "${name}.sha256" "${package_url}.sha256" && [ -s "$name" ] && [ -s "${name}.sha256" ]; then
    downloaded=$tag
    break
  fi
  rm -f "$name" "${name}.sha256"
done
if [ -z "$downloaded" ]; then
  die "No ${arch} runner package is published for ${version}"
fi

if [ "$(wc -l < "${name}.sha256")" -ne 1 ]; then
  die "Published checksum must be one line"
fi
checksum_line=$(tr -d '\r' < "${name}.sha256")
expected=$(sha256sum "$name")
if [ "$checksum_line" != "$expected" ]; then
  die "Checksum verification failed for ${name}"
fi
sha256sum --strict --check "${name}.sha256" || die "Checksum verification failed for ${name}"

# Docker access for agent jobs: a rootless Docker daemon that runs as paws-runner. The package never
# prompts; this script asks only on a terminal, when Docker Engine is installed and the daemon isn't set up.
docker_engine=""
if command -v dockerd >/dev/null 2>&1; then
  docker_engine=1
fi
if [ -z "$docker_access" ] && [ -n "$docker_engine" ] && [ ! -e /etc/systemd/system/paws-docker.service ] \
  && ( : < /dev/tty ) 2>/dev/null; then
  printf '%s\n' \
    "Docker Engine is installed on this host. Agent jobs can get rootless Docker: a separate Docker" \
    "daemon that runs as the paws-runner account, not as root, without the docker group. It needs" \
    "the rootlesskit, uidmap and slirp4netns packages, which this installer adds." > /dev/tty
  printf '%s' "Set up rootless Docker for agent jobs? [y/N] " > /dev/tty
  answer=""
  read -r answer < /dev/tty || answer=""
  case $answer in
    y|Y|yes|YES|Yes) docker_access=grant ;;
    *) docker_access=deny ;;
  esac
fi
if [ -n "$docker_access" ]; then
  export PAWS_RUNNER_DOCKER_ACCESS="$docker_access"
else
  unset PAWS_RUNNER_DOCKER_ACCESS
fi

printf '%s\n' "Installing paws-runner ${version} (${arch})"
export DEBIAN_FRONTEND=noninteractive
apt-get update
# Package configuration can't install these itself: dpkg holds the lock while it runs.
if [ "$docker_access" = grant ] && [ -n "$docker_engine" ]; then
  apt-get install -y rootlesskit uidmap slirp4netns
fi
apt-get install -y "${workdir}/${name}"
printf '%s\n' "Installed paws-runner ${version}"
