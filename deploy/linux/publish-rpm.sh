set -euo pipefail
set +x
# Publish the control-plane RPMs to the dnf repository under rpm/ in the apt repository's bucket.
for name in PAWS_APT_R2_ACCOUNT_ID PAWS_APT_R2_ACCESS_KEY_ID PAWS_APT_R2_SECRET_ACCESS_KEY PAWS_APT_R2_BUCKET PAWS_APT_SIGNING_KEY PAWS_APT_SIGNING_PASSPHRASE; do
  if [[ -z "${!name:-}" ]]; then
    echo 'Skipping dnf publication: protected release environment secrets are incomplete.'
    exit 0
  fi
done
[[ "${1:-}" == build && -n "${2:-}" ]] || { echo 'Usage: publish-rpm.sh build <package directory>' >&2; exit 1; }
for arch in x86_64 aarch64; do
  if ! compgen -G "$2/paws-control-plane-*.${arch}.rpm" >/dev/null; then echo "Missing required paws-control-plane for $arch" >&2; exit 1; fi
done
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  escaped=${PAWS_APT_SIGNING_PASSPHRASE//'%'/'%25'}
  escaped=${escaped//$'\r'/'%0D'}
  escaped=${escaped//$'\n'/'%0A'}
  printf '::add-mask::%s\n' "$escaped"
fi
script=$(realpath "$(dirname "$0")/rpm-repository.sh")
work=$(mktemp -d /tmp/paws-rpm.XXXXXXXX)
export GNUPGHOME="$work/gnupg"
trap 'gpgconf --kill gpg-agent; rm -rf -- "$work"' EXIT
mkdir -m 700 "$GNUPGHOME"
printf '%s' "$PAWS_APT_SIGNING_KEY" | gpg --batch --import
gpg --batch --armor --export > "$work/paws.asc"
test -s "$work/paws.asc"
export AWS_ACCESS_KEY_ID="$PAWS_APT_R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$PAWS_APT_R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto
endpoint="https://$PAWS_APT_R2_ACCOUNT_ID.r2.cloudflarestorage.com"
remote="s3://$PAWS_APT_R2_BUCKET/rpm"
mkdir "$work/repository"
aws --endpoint-url "$endpoint" s3 sync "$remote/packages/" "$work/repository/packages/"
bash "$script" build "$work/repository" "$2"
# Packages and the metadata files repomd.xml names go up before the signed index that points at them. Nothing is deleted:
# clients holding the previous repomd.xml can still fetch what it lists.
aws --endpoint-url "$endpoint" s3 sync "$work/repository/packages/" "$remote/packages/"
aws --endpoint-url "$endpoint" s3 sync "$work/repository/repodata/" "$remote/repodata/" --exclude 'repomd.xml*'
aws --endpoint-url "$endpoint" s3 cp "$work/paws.asc" "$remote/paws.asc"
aws --endpoint-url "$endpoint" s3 cp "$work/repository/repodata/repomd.xml.asc" "$remote/repodata/repomd.xml.asc"
aws --endpoint-url "$endpoint" s3 cp "$work/repository/repodata/repomd.xml" "$remote/repodata/repomd.xml"
