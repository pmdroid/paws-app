set -euo pipefail
# Install, upgrade and remove the control-plane RPM in each container image given as an argument, with a fixture in
# place of the Bun binary: first from the package files, then with install.sh through a signed dnf repository that
# publish-rpm.sh builds and dnf upgrade. Needs rpmbuild, rpmsign, createrepo_c, gpg, python3 and Docker on the host.
umask 022
here=$(realpath "$(dirname "$0")")
work=$(mktemp -d /tmp/paws-rpm.XXXXXXXX)
export GNUPGHOME="$work/gnupg"
trap 'kill "${server:-}" 2>/dev/null || true; for id in "${containers[@]}"; do docker rm -f "$id" >/dev/null 2>&1 || true; done; gpgconf --kill gpg-agent; rm -rf -- "$work"' EXIT
containers=()
printf '#!/bin/sh\necho paws fixture\n' > "$work/paws"
case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) echo "Unsupported architecture" >&2; exit 1 ;; esac
for version in 1.0.0 1.0.1; do
  python3 -I -B "$here/rpm-package.py" --binary "$work/paws" --version "$version" --architecture "$arch" --output "$work/rpms"
done
cat > "$work/check.sh" <<'CHECK'
set -euxo pipefail
cd /rpms
sha256sum -c paws-control-plane-1.0.0-1.*.rpm.sha256 paws-control-plane-1.0.1-1.*.rpm.sha256
dnf install -y ./paws-control-plane-1.0.0-1.*.rpm
getent passwd paws | grep -q ':/var/lib/paws:/usr/sbin/nologin$'
getent group paws
test -f /usr/lib/systemd/system/paws.service
test -L /etc/systemd/system/multi-user.target.wants/paws.service
test "$(stat -c '%a %U %G' /etc/paws/control-plane.env)" = '600 root paws'
test "$(stat -c '%a %U %G' /var/lib/paws)" = '700 paws paws'
test "$(paws)" = 'paws fixture'
printf 'PAWS_PUBLIC_URL=https://paws.test\n' >> /etc/paws/control-plane.env
saved=$(sha256sum /etc/paws/control-plane.env)
install -d -o paws -g paws -m 0700 /var/lib/paws/pglite
echo database > /var/lib/paws/pglite/data
dnf upgrade -y ./paws-control-plane-1.0.1-1.*.rpm
test "$(rpm -q --qf '%{VERSION}' paws-control-plane)" = 1.0.1
test "$(sha256sum /etc/paws/control-plane.env)" = "$saved"
test ! -e /etc/paws/control-plane.env.rpmnew
test "$(cat /var/lib/paws/backups/pglite-1.0.0-*/data)" = database
test -L /etc/systemd/system/multi-user.target.wants/paws.service
dnf remove -y paws-control-plane
test ! -e /usr/lib/systemd/system/paws.service
test ! -e /etc/systemd/system/multi-user.target.wants/paws.service
grep -qx 'PAWS_PUBLIC_URL=https://paws.test' /etc/paws/control-plane.env.rpmsave
CHECK
for image in "$@"; do
  echo "::group::$image"
  docker run --rm -v "$work/rpms:/rpms:ro" -v "$work/check.sh:/check.sh:ro" "$image" bash /check.sh
  echo "::endgroup::"
done

# The release key as published: an offline primary key with a signing subkey, and only the secret subkey exported.
mkdir -m 700 "$GNUPGHOME"
gpg --batch --pinentry-mode loopback --passphrase test --quick-generate-key 'Paws RPM test <rpm@example.invalid>' rsa3072 cert 1d
primary=$(gpg --batch --with-colons --list-keys | awk -F: '$1 == "fpr" { print $10; exit }')
gpg --batch --pinentry-mode loopback --passphrase test --quick-add-key "$primary" rsa3072 sign 1d
subkey=$(gpg --batch --with-colons --list-keys | awk -F: '$1 == "fpr" { count++; if (count == 2) { print $10; exit } }')
export PAWS_APT_SIGNING_KEY=$(gpg --batch --pinentry-mode loopback --passphrase test --armor --export-secret-subkeys "$subkey!")
export PAWS_APT_SIGNING_PASSPHRASE=test
gpg --batch --export "$primary" > "$work/public.gpg"
gpgconf --kill gpg-agent
rm -rf -- "$GNUPGHOME"
mkdir -m 700 "$GNUPGHOME"
publisher="$here/publish-rpm.sh"
output=$(env -i PATH="$PATH" bash "$publisher" build "$work/rpms")
[[ "$output" == *'Skipping dnf publication'* ]]
mkdir "$work/bin" "$work/remote"
cat > "$work/bin/aws" <<'AWS'
#!/usr/bin/python3
import os, pathlib, shutil, sys
command, source, target = sys.argv[4:7]
with open(os.environ["AWS_TEST_LOG"], "a") as log:
    log.write(" ".join(sys.argv[4:]) + "\n")
def path(value):
    return pathlib.Path(value.replace("s3://fixture", os.environ["AWS_TEST_REMOTE"]))
source, target = path(source), path(target)
excluded = sys.argv[7:9] == ["--exclude", "repomd.xml*"]
if command == "sync":
    if not source.exists(): sys.exit(0)
    for file in source.rglob("*"):
        if file.is_file() and not (excluded and file.name.startswith("repomd.xml")):
            destination = target / file.relative_to(source)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, destination)
else:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
AWS
chmod +x "$work/bin/aws"
export PATH="$work/bin:$PATH" AWS_TEST_REMOTE="$work/remote" AWS_TEST_LOG="$work/aws.log"
export PAWS_APT_R2_ACCOUNT_ID=fixture PAWS_APT_R2_ACCESS_KEY_ID=fixture PAWS_APT_R2_SECRET_ACCESS_KEY=fixture PAWS_APT_R2_BUCKET=fixture
mkdir "$work/first" "$work/second" "$work/one-arch"
# A release carries both architectures; the host's own goes in $work/rpms, the other in $work/other-rpms.
other=arm64
[[ "$arch" == amd64 ]] || other=amd64
for version in 1.0.0 1.0.1; do
  python3 -I -B "$here/rpm-package.py" --binary "$work/paws" --version "$version" --architecture "$other" --output "$work/other-rpms" >/dev/null
done
cp "$work/rpms"/paws-control-plane-1.0.0-1.*.rpm "$work/other-rpms"/paws-control-plane-1.0.0-1.*.rpm "$work/first/"
cp "$work/rpms"/paws-control-plane-1.0.1-1.*.rpm "$work/other-rpms"/paws-control-plane-1.0.1-1.*.rpm "$work/second/"
cp "$work/rpms"/paws-control-plane-1.0.1-1.*.rpm "$work/one-arch/"
if bash "$publisher" build "$work/one-arch"; then exit 1; fi
test ! -s "$work/aws.log"
bash "$publisher" build "$work/first"
# The signed index goes up after the packages and metadata it lists.
test "$(tail -n 3 "$work/aws.log" | awk '{ print $3 }' | tr '\n' ' ')" = 's3://fixture/rpm/paws.asc s3://fixture/rpm/repodata/repomd.xml.asc s3://fixture/rpm/repodata/repomd.xml '
# The package entries in the primary metadata repomd.xml names; older metadata files stay beside it.
packages_listed() {
  python3 -I - "$1" <<'LISTED'
import gzip, pathlib, sys, xml.etree.ElementTree as tree
root = pathlib.Path(sys.argv[1])
names = {"repo": "http://linux.duke.edu/metadata/repo", "common": "http://linux.duke.edu/metadata/common"}
location = tree.parse(root / "repodata/repomd.xml").find("repo:data[@type='primary']/repo:location", names).get("href")
for package in tree.fromstring(gzip.decompress((root / location).read_bytes())).findall("common:package", names):
    print(package.find("common:version", names).get("ver"), package.find("common:arch", names).text)
LISTED
}
check_remote() {
  gpgv --keyring "$work/public.gpg" "$work/remote/rpm/repodata/repomd.xml.asc" "$work/remote/rpm/repodata/repomd.xml"
  rm -rf -- "$work/rpmdb"
  mkdir "$work/rpmdb"
  rpmdb --dbpath "$work/rpmdb" --initdb
  rpmkeys --dbpath "$work/rpmdb" --import "$work/remote/rpm/paws.asc"
  for package in "$work/remote/rpm/packages"/*.rpm; do
    rpmkeys --dbpath "$work/rpmdb" --checksig "$package" | grep -q ' signatures OK$'
  done
  test "$(packages_listed "$work/remote/rpm" | wc -l)" = "$1"
}
check_remote 2
cp -r "$work/remote" "$work/published-first"
: > "$work/aws.log"
bash "$publisher" build "$work/first"
bash "$publisher" build "$work/second"
check_remote 4
cp -r "$work/remote" "$work/published-second"
gpg --batch --import <<< "$PAWS_APT_SIGNING_KEY"
rebuilt="$work/rebuilt"
sleep 1
python3 -I -B "$here/rpm-package.py" --binary "$work/paws" --version 1.0.1 --architecture "$arch" --output "$rebuilt" >/dev/null
if bash "$publisher" build "$rebuilt" 2>/dev/null; then exit 1; fi
if bash "$here/rpm-repository.sh" build "$work/remote/rpm" "$rebuilt"; then exit 1; fi
diff -r "$work/published-second" "$work/remote"
# The metadata keeps the newest ten versions.
cp -r "$work/published-second" "$work/retention"
for version in 1.0.{2..10}; do
  python3 -I -B "$here/rpm-package.py" --binary "$work/paws" --version "$version" --architecture "$arch" --output "$work/retention-incoming" >/dev/null
done
bash "$here/rpm-repository.sh" build "$work/retention/rpm" "$work/retention-incoming"
listed=$(packages_listed "$work/retention/rpm")
test "$(wc -l <<< "$listed")" = 11
! grep -q '^1\.0\.0 ' <<< "$listed"
grep -qx "1.0.10 $(uname -m)" <<< "$listed"
test -f "$work/remote/rpm/packages/paws-control-plane-1.0.0-1.$(uname -m).rpm"

# Variants dnf must refuse: an unsigned newer package behind a validly signed index, and an index signed by another key.
cp -r "$work/published-first" "$work/unsigned-package"
python3 -I -B "$here/rpm-package.py" --binary "$work/paws" --version 1.0.2 --architecture "$arch" --output "$work/unsigned-package/rpm/packages" >/dev/null
rm "$work/unsigned-package/rpm/packages"/*.sha256
createrepo_c --quiet --checksum sha256 --general-compress-type gz "$work/unsigned-package/rpm"
gpg --batch --yes --pinentry-mode loopback --passphrase test --armor --detach-sign --output "$work/unsigned-package/rpm/repodata/repomd.xml.asc" "$work/unsigned-package/rpm/repodata/repomd.xml"
cp -r "$work/published-first" "$work/foreign-index"
mkdir -m 700 "$work/foreign"
GNUPGHOME="$work/foreign" gpg --batch --pinentry-mode loopback --passphrase '' --quick-generate-key 'Foreign <foreign@example.invalid>' rsa2048 sign 1d
GNUPGHOME="$work/foreign" gpg --batch --yes --armor --detach-sign --output "$work/foreign-index/rpm/repodata/repomd.xml.asc" "$work/foreign-index/rpm/repodata/repomd.xml"
GNUPGHOME="$work/foreign" gpgconf --kill gpg-agent

# Serve one of the published trees at a time from $work/serve/rpm.
mkdir "$work/serve"
serve() { ln -sfn "$work/$1/rpm" "$work/serve/rpm"; }
serve published-first
python3 -I -c '
import functools, http.server, sys
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1])
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
open(sys.argv[2], "w").write(str(server.server_port))
server.serve_forever()
' "$work/serve" "$work/port" 2>/dev/null &
server=$!
for _ in $(seq 50); do [[ -s "$work/port" ]] && break; sleep 0.1; done
base="http://127.0.0.1:$(cat "$work/port")"
cat > "$work/dnf-check.sh" <<'CHECK'
set -euxo pipefail
export PAWS_RUNNER_ALLOW_HTTP_BASE=1
case $1 in
  install)
    if sh /install.sh --runner 2> /tmp/runner.err; then exit 1; fi
    grep -q 'There is no paws-runner RPM yet' /tmp/runner.err
    test ! -e /etc/yum.repos.d/paws.repo
    sh /install.sh 1.0.0 | tee /tmp/install.out
    grep -q 'Set the public URL and TLS paths in /etc/paws/control-plane.env' /tmp/install.out
    grep -qx gpgcheck=1 /etc/yum.repos.d/paws.repo
    grep -qx repo_gpgcheck=1 /etc/yum.repos.d/paws.repo
    grep -qx "gpgkey=$PAWS_RUNNER_DOWNLOAD_BASE/rpm/paws.asc" /etc/yum.repos.d/paws.repo
    test "$(rpm -q --qf '%{VERSION}' paws-control-plane)" = 1.0.0
    test "$(paws)" = 'paws fixture'
    printf 'PAWS_PUBLIC_URL=https://paws.test
' >> /etc/paws/control-plane.env
    sha256sum /etc/paws/control-plane.env > /root/environment.sha256
    ;;
  refuse)
    if dnf upgrade -y --refresh paws-control-plane; then exit 1; fi
    test "$(rpm -q --qf '%{VERSION}' paws-control-plane)" = 1.0.0
    ;;
  upgrade)
    dnf upgrade -y --refresh paws-control-plane
    test "$(rpm -q --qf '%{VERSION}' paws-control-plane)" = 1.0.1
    sha256sum -c /root/environment.sha256
    test ! -e /etc/paws/control-plane.env.rpmnew
    test -L /etc/systemd/system/multi-user.target.wants/paws.service
    dnf list --showduplicates paws-control-plane | grep -q '1\.0\.0-1'
    ;;
esac
CHECK
for image in "$@"; do
  echo "::group::$image (dnf repository)"
  serve published-first
  id=$(docker run -d --network host -e PAWS_RUNNER_DOWNLOAD_BASE="$base" -v "$here/install.sh:/install.sh:ro" -v "$work/dnf-check.sh:/dnf-check.sh:ro" "$image" sleep infinity)
  containers+=("$id")
  docker exec "$id" bash /dnf-check.sh install
  serve unsigned-package
  docker exec "$id" bash /dnf-check.sh refuse
  serve foreign-index
  docker exec "$id" bash /dnf-check.sh refuse
  serve published-second
  docker exec "$id" bash /dnf-check.sh upgrade
  docker rm -f "$id" >/dev/null
  echo "::endgroup::"
done
echo 'RPM repository checks passed'
