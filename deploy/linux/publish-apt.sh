set -euo pipefail
set +x
for name in PAWS_APT_R2_ACCOUNT_ID PAWS_APT_R2_ACCESS_KEY_ID PAWS_APT_R2_SECRET_ACCESS_KEY PAWS_APT_R2_BUCKET PAWS_APT_SIGNING_KEY PAWS_APT_SIGNING_PASSPHRASE; do
  if [[ -z "${!name:-}" ]]; then
    echo 'Skipping apt publication: protected release environment secrets are incomplete.'
    exit 0
  fi
done
if [[ "$1" == build ]]; then
  for package in paws-runner paws-control-plane; do
    for arch in amd64 arm64; do
      if ! compgen -G "$2/${package}_*_${arch}.deb" >/dev/null; then
        if [[ "$package" == paws-runner ]]; then echo "Missing required paws-runner for $arch" >&2; exit 1; fi
        echo "Skipping optional paws-control-plane for $arch: no package in this release"
      fi
    done
  done
fi
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  escaped=${PAWS_APT_SIGNING_PASSPHRASE//'%'/'%25'}
  escaped=${escaped//$'\r'/'%0D'}
  escaped=${escaped//$'\n'/'%0A'}
  printf '::add-mask::%s\n' "$escaped"
fi
script=$(realpath "$(dirname "$0")/apt-repository.sh")
work=$(mktemp -d /tmp/paws-apt.XXXXXXXX)
export GNUPGHOME="$work/gnupg"
trap 'gpgconf --kill gpg-agent; rm -rf -- "$work"' EXIT
mkdir -m 700 "$GNUPGHOME"
printf '%s' "$PAWS_APT_SIGNING_KEY" | gpg --batch --import
gpg --batch --export > "$work/paws.gpg"
test -s "$work/paws.gpg"
export AWS_ACCESS_KEY_ID="$PAWS_APT_R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$PAWS_APT_R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto
endpoint="https://$PAWS_APT_R2_ACCOUNT_ID.r2.cloudflarestorage.com"
remote="s3://$PAWS_APT_R2_BUCKET"
mkdir "$work/repository"
if [[ "$1" == resign_only ]]; then
  mkdir -p "$work/repository/dists/stable"
  aws --endpoint-url "$endpoint" s3 cp "$remote/dists/stable/InRelease" "$work/repository/dists/stable/InRelease"
else
  aws --endpoint-url "$endpoint" s3 sync "$remote/pool/" "$work/repository/pool/"
  aws --endpoint-url "$endpoint" s3 sync "$remote/dists/stable/main/" "$work/repository/dists/stable/main/" --exclude '*' --include '*/by-hash/*'
fi
bash "$script" "$1" "$work/repository" "${2:-}"
if [[ "$1" == build ]]; then
  aws --endpoint-url "$endpoint" s3 sync "$work/repository/pool/" "$remote/pool/"
  aws --endpoint-url "$endpoint" s3 sync "$work/repository/dists/stable/main/" "$remote/dists/stable/main/" --exclude '*' --include '*/by-hash/*'
  aws --endpoint-url "$endpoint" s3 sync "$work/repository/dists/stable/main/" "$remote/dists/stable/main/" --exclude '*/by-hash/*'
fi
aws --endpoint-url "$endpoint" s3 cp "$work/paws.gpg" "$remote/paws.gpg"
aws --endpoint-url "$endpoint" s3 cp "$work/repository/dists/stable/InRelease" "$remote/dists/stable/InRelease"
if [[ "$1" == build ]]; then
  aws --endpoint-url "$endpoint" s3 sync "$work/repository/dists/stable/main/" "$remote/dists/stable/main/" --delete --exclude '*' --include '*/by-hash/*'
  aws --endpoint-url "$endpoint" s3 cp "$(dirname "$script")/install-runner.sh" "$remote/install-runner.sh" --content-type 'text/x-shellscript; charset=utf-8'
fi
