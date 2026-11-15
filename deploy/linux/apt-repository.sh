set -euo pipefail
set +x
mode=$1
root=$2
incoming=${3:-}
mkdir -p "$root/pool/main/p" "$root/dists/stable"
cd "$root"
if [[ "$mode" == build ]]; then
  while IFS= read -r -d '' deb; do
    package=$(dpkg-deb -f "$deb" Package)
    version=$(dpkg-deb -f "$deb" Version)
    arch=$(dpkg-deb -f "$deb" Architecture)
    [[ "$package" =~ ^[a-z0-9][a-z0-9+.-]+$ ]]
    [[ "$version" =~ ^[0-9][a-zA-Z0-9.+:~_-]*$ ]]
    [[ "$arch" == amd64 || "$arch" == arm64 ]]
    target="pool/main/p/$package/$(basename "$deb")"
    if [[ -e "$target" ]]; then
      cmp -- "$deb" "$target" || { echo 'Refusing to overwrite an existing package' >&2; exit 1; }
    fi
    mkdir -p "pool/main/p/$package"
    cp -n -- "$deb" "pool/main/p/$package/"
  done < <(find "$incoming" -name '*.deb' -type f -print0)
  for directory in pool/main/p/*; do
    [[ -d "$directory" ]] || continue
    versions=()
    while read -r version; do
      position=0
      while ((position < ${#versions[@]})) && dpkg --compare-versions "${versions[position]}" ge "$version"; do ((position+=1)); done
      versions=("${versions[@]:0:position}" "$version" "${versions[@]:position}")
      versions=("${versions[@]:0:10}")
    done < <(for deb in "$directory"/*.deb; do dpkg-deb -f "$deb" Version; done | sort -u)
    versions=$(printf '%s\n' "${versions[@]}")
    for deb in "$directory"/*.deb; do
      version=$(dpkg-deb -f "$deb" Version)
      if ! grep -Fxq -- "$version" <<< "$versions"; then rm -- "$deb"; fi
    done
  done
  for arch in amd64 arm64; do
    directory="dists/stable/main/binary-$arch"
    mkdir -p "$directory"
    apt-ftparchive -a "$arch" packages pool > "$directory/Packages"
    gzip -nc "$directory/Packages" > "$directory/Packages.gz"
  done
elif [[ "$mode" != resign_only ]]; then
  exit 1
fi
if [[ "$mode" == build ]]; then
  apt-ftparchive --sha512=no -o APT::FTPArchive::Release::Suite=stable -o APT::FTPArchive::Release::Codename=stable -o APT::FTPArchive::Release::Architectures='amd64 arm64' -o APT::FTPArchive::Release::Components=main release dists/stable > Release.new
  printf 'Acquire-By-Hash: yes\n' >> Release.new
  for index in dists/stable/main/binary-*/Packages{,.gz}; do
    hashes="$(dirname "$index")/by-hash"
    mkdir -p "$hashes/SHA256"
    digest=$(sha256sum "$index" | cut -d ' ' -f1)
    cp "$index" "$hashes/SHA256/$digest"
    history="$hashes/$(basename "$index").history"
    touch "$history"
    { echo "$digest"; cat "$history"; } | awk '!seen[$0]++ && ++count <= 3' > "$history.new"
    mv "$history.new" "$history"
  done
  for hashes in dists/stable/main/binary-*/by-hash; do
    for file in "$hashes/SHA256/"*; do grep -Fxq "$(basename "$file")" "$hashes/"*.history || rm "$file"; done
  done
else
  gpg --batch --yes --output dists/stable/Release --decrypt dists/stable/InRelease
  sed '/^Valid-Until:/d; /^Date:/d' dists/stable/Release > Release.new
  printf 'Date: %s\n' "$(date -Ru)" >> Release.new
fi
printf 'Valid-Until: %s\n' "$(date -Ru -d '+90 days')" >> Release.new
mv Release.new dists/stable/Release
printf '%s' "$PAWS_APT_SIGNING_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 --clearsign --output dists/stable/InRelease dists/stable/Release
