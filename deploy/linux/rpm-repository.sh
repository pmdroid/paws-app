set -euo pipefail
set +x
# Add the RPMs under $3 to the dnf repository at $2, sign each new package with rpmsign, regenerate the metadata
# from every retained package with createrepo_c and sign repodata/repomd.xml (detached, armored). Signs with the only secret key in GNUPGHOME.
mode=$1
root=$2
incoming=${3:-}
[[ "$mode" == build ]] || exit 1
mkdir -p "$root/packages"
cd "$root"
fingerprint=$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1 == "fpr" { print $10; exit }')
[[ -n "$fingerprint" ]]
passphrase=$(mktemp "$GNUPGHOME/passphrase.XXXXXXXX")
trap 'rm -f -- "$passphrase"' EXIT
printf '%s' "$PAWS_APT_SIGNING_PASSPHRASE" > "$passphrase"
while IFS= read -r -d '' package; do
  read -r name version release arch < <(rpm -qp --nosignature --qf '%{NAME} %{VERSION} %{RELEASE} %{ARCH}\n' -- "$package")
  [[ "$name" =~ ^[a-z0-9][a-z0-9+.-]+$ ]]
  [[ "$version" =~ ^[0-9][a-zA-Z0-9.+~_]*$ ]]
  [[ "$release" =~ ^[0-9][a-zA-Z0-9.+~_]*$ ]]
  [[ "$arch" == x86_64 || "$arch" == aarch64 ]]
  target="packages/$name-$version-$release.$arch.rpm"
  if [[ -e "$target" ]]; then
    # The published copy carries a signature the incoming one lacks. Signing leaves the main header alone, and the
    # header carries the payload digest, so equal header digests mean the same package.
    incoming_digest=$(rpm -qp --nosignature --qf '%{SHA256HEADER}' -- "$package")
    published_digest=$(rpm -qp --nosignature --qf '%{SHA256HEADER}' -- "$target")
    [[ "$incoming_digest" =~ ^[0-9a-f]{64}$ && "$incoming_digest" == "$published_digest" ]] || { echo 'Refusing to overwrite an existing package' >&2; exit 1; }
    continue
  fi
  cp -- "$package" "$target.new"
  rpmsign --addsign \
    --define "_gpg_path $GNUPGHOME" \
    --define "_gpg_name $fingerprint" \
    --define '_gpg_digest_algo sha256' \
    --define "_gpg_sign_cmd_extra_args --batch --pinentry-mode loopback --passphrase-file $passphrase" \
    "$target.new" >/dev/null
  mv -- "$target.new" "$target"
done < <(find "$incoming" -name '*.rpm' -type f -print0)
# The metadata lists the newest ten versions of each package; older files stay for clients with cached metadata.
for name in $(for package in packages/*.rpm; do [[ -e "$package" ]] && rpm -qp --nosignature --qf '%{NAME}\n' -- "$package"; done | sort -u); do
  keep=$(for package in packages/"$name"-*.rpm; do rpm -qp --nosignature --qf '%{NAME} %{VERSION}\n' -- "$package"; done \
    | awk -v name="$name" '$1 == name { print $2 }' | sort -u -V -r | head -n 10)
  for package in packages/"$name"-*.rpm; do
    read -r package_name version < <(rpm -qp --nosignature --qf '%{NAME} %{VERSION}\n' -- "$package")
    [[ "$package_name" == "$name" ]] || continue
    grep -Fxq -- "$version" <<< "$keep" || rm -- "$package"
  done
done
createrepo_c --quiet --checksum sha256 --general-compress-type gz .
printf '%s' "$PAWS_APT_SIGNING_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 --local-user "$fingerprint" --armor --detach-sign --output repodata/repomd.xml.asc repodata/repomd.xml
