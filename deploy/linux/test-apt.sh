set -euo pipefail
umask 022
script=$(realpath "$(dirname "$0")/apt-repository.sh")
publisher=$(realpath "$(dirname "$0")/publish-apt.sh")
work=$(mktemp -d /tmp/paws-apt.XXXXXXXX)
export GNUPGHOME="$work/gnupg" PAWS_APT_SIGNING_PASSPHRASE=test
trap 'gpgconf --kill gpg-agent; rm -rf -- "$work"' EXIT
mkdir -m 700 "$GNUPGHOME"
gpg --batch --pinentry-mode loopback --passphrase test --quick-generate-key 'Apt test <apt@example.invalid>' rsa2048 sign 1d
gpg --export > "$work/public.gpg"
mkdir "$work/incoming" "$work/repo"
make_deb() {
  mkdir -p "$work/package/DEBIAN"
  printf 'Package: %s\nVersion: %s\nArchitecture: %s\nMaintainer: Test <test@example.invalid>\nDescription: Fixture\n' "$1" "$2" "$3" > "$work/package/DEBIAN/control"
  dpkg-deb --build "$work/package" "$work/incoming/${1}_${2}_${3}.deb" >/dev/null
}
for package in paws-runner paws-control-plane; do
  for version in 1.0.1 1.0.2; do
    for arch in amd64 arm64; do make_deb "$package" "$version" "$arch"; done
  done
done
bash "$script" build "$work/repo" "$work/incoming"
assert_validity() {
  expiry=$(date -d "$(sed -n 's/^Valid-Until: //p' "$work/repo/dists/stable/Release")" +%s)
  remaining=$((expiry - $(date +%s)))
  test "$remaining" -ge $((90 * 86400 - 60))
  test "$remaining" -le $((90 * 86400))
}
assert_validity
for arch in amd64 arm64; do
  index="$work/repo/dists/stable/main/binary-$arch/Packages"
  test "$(grep -c '^Package:' "$index")" = 4
  while read -r filename hash; do
    test "$(sha256sum "$work/repo/$filename" | cut -d ' ' -f1)" = "$hash"
  done < <(awk '/^Filename:/{file=$2} /^SHA256:/{print file, $2}' "$index")
done
cp -r "$work/repo/dists" "$work/before"
cp -r "$work/repo/pool" "$work/pool-before"
sed -i 's/^Valid-Until:.*/Valid-Until: Mon, 01 Jan 2001 00:00:00 +0000/' "$work/repo/dists/stable/Release"
printf '%s' "$PAWS_APT_SIGNING_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 --clearsign --output "$work/repo/dists/stable/InRelease" "$work/repo/dists/stable/Release"
bash "$script" resign_only "$work/repo"
assert_validity
gpgv --keyring "$work/public.gpg" "$work/repo/dists/stable/InRelease"
diff -r "$work/pool-before" "$work/repo/pool"
diff -r "$work/before/stable/main" "$work/repo/dists/stable/main"
mkdir "$work/bin" "$work/remote"
cat > "$work/bin/aws" <<'AWS'
#!/usr/bin/python3
import fnmatch, os, pathlib, shutil, sys
command, source, target = sys.argv[4:7]
with open(os.environ["AWS_TEST_LOG"], "a") as log:
    log.write(" ".join(sys.argv[4:]) + "\n")
def path(value):
    return pathlib.Path(value.replace("s3://fixture", os.environ["AWS_TEST_REMOTE"]))
source, target = path(source), path(target)
if os.environ.get("FAIL_INRELEASE") and target.name == "InRelease": sys.exit(18)
if os.environ.get("FAIL_CANONICAL") and sys.argv[-2:] == ["--exclude", "*/by-hash/*"]: sys.exit(17)
def included(name):
    result = True
    options = [arg for arg in sys.argv[7:] if arg != "--delete"]
    for flag, pattern in zip(options[::2], options[1::2]):
        if fnmatch.fnmatch(name, pattern): result = flag == "--include"
    return result
if command == "sync":
    for file in source.rglob("*"):
        relative = file.relative_to(source)
        if file.is_file() and included(str(relative)):
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, destination)
    if "--delete" in sys.argv:
        for file in target.rglob("*"):
            if file.is_file() and included(str(file.relative_to(target))) and not (source / file.relative_to(target)).exists(): file.unlink()
else:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
AWS
chmod +x "$work/bin/aws"
export PATH="$work/bin:$PATH" AWS_TEST_REMOTE="$work/remote" AWS_TEST_LOG="$work/aws.log"
export PAWS_APT_R2_ACCOUNT_ID=fixture PAWS_APT_R2_ACCESS_KEY_ID=fixture PAWS_APT_R2_SECRET_ACCESS_KEY=fixture PAWS_APT_R2_BUCKET=fixture
export PAWS_APT_SIGNING_KEY=$(gpg --batch --pinentry-mode loopback --passphrase test --armor --export-secret-keys)
bash "$publisher" build "$work/incoming"
awk '$3 ~ /^s3:/ {print $3, $4, $5, $6, $7}' "$work/aws.log" > "$work/order"
head -5 "$work/order" | sed 's/ *$//' > "$work/phases"
printf '%s\n' 's3://fixture/pool/' 's3://fixture/dists/stable/main/ --exclude * --include */by-hash/*' 's3://fixture/dists/stable/main/ --exclude */by-hash/*' 's3://fixture/paws.gpg' 's3://fixture/dists/stable/InRelease' > "$work/expected"
cmp "$work/expected" "$work/phases"
cmp "$work/public.gpg" "$work/remote/paws.gpg"
gpgv --keyring "$work/remote/paws.gpg" "$work/remote/dists/stable/InRelease"
test ! -e "$work/remote/dists/stable/Release" && test ! -e "$work/remote/dists/stable/Release.gpg"
cp -r "$work/remote" "$work/remote-before"
: > "$work/aws.log"
bash "$publisher" resign_only
test "$(wc -l < "$work/aws.log")" = 3
cmp "$work/public.gpg" "$work/remote/paws.gpg"
gpgv --keyring "$work/remote/paws.gpg" "$work/remote/dists/stable/InRelease"
! grep -q sync "$work/aws.log"
diff -r "$work/remote-before/pool" "$work/remote/pool"
diff -r "$work/remote-before/dists/stable/main" "$work/remote/dists/stable/main"
cp -r "$work/remote" "$work/failure-before"
make_deb paws-runner 1.0.3 amd64
if FAIL_CANONICAL=1 bash "$publisher" build "$work/incoming"; then exit 1; fi
cmp "$work/failure-before/dists/stable/InRelease" "$work/remote/dists/stable/InRelease"
gpgv --keyring "$work/public.gpg" "$work/remote/dists/stable/InRelease"
grep -q '^Acquire-By-Hash: yes' "$work/failure-before/dists/stable/InRelease"
diff -r "$work/failure-before/dists/stable/main/binary-amd64/Packages" "$work/remote/dists/stable/main/binary-amd64/Packages"
for index in "$work/failure-before"/dists/stable/main/binary-*/Packages{,.gz}; do
  for algorithm in SHA256; do
    digest=$("${algorithm,,}sum" "$index" | cut -d ' ' -f1)
    cmp "$index" "$work/remote/$(dirname "${index#"$work/failure-before/"}")/by-hash/$algorithm/$digest"
  done
done
if FAIL_INRELEASE=1 bash "$publisher" build "$work/incoming"; then exit 1; fi
cmp "$work/failure-before/dists/stable/InRelease" "$work/remote/dists/stable/InRelease"
for version in {4..13}; do
  for arch in amd64 arm64; do make_deb paws-runner "1.0.$version" "$arch"; done
  bash "$publisher" build "$work/incoming"
done
test -f "$work/remote/pool/main/p/paws-runner/paws-runner_1.0.1_amd64.deb"
! grep -q '^Version: 1.0.1$' "$work/remote/dists/stable/main/binary-amd64/Packages"
hashes="$work/remote/dists/stable/main/binary-amd64/by-hash"
test "$(wc -l < "$hashes/Packages.history")" = 3
test "$(wc -l < "$hashes/Packages.gz.history")" = 3
test "$(find "$hashes/SHA256" -type f | wc -l)" = 6
mkdir "$work/runner-only" "$work/runner-remote"
cp "$work/incoming"/paws-runner_*.deb "$work/runner-only/"
export AWS_TEST_REMOTE="$work/runner-remote"
output=$(bash "$publisher" build "$work/runner-only")
for arch in amd64 arm64; do
  grep -q "Skipping optional paws-control-plane for $arch" <<< "$output"
  index="$AWS_TEST_REMOTE/dists/stable/main/binary-$arch/Packages"
  test "$(grep -c '^Package: paws-runner$' "$index")" -ge 2
  ! grep -q '^Package: paws-control-plane$' "$index"
done
gpgv --keyring "$AWS_TEST_REMOTE/paws.gpg" "$AWS_TEST_REMOTE/dists/stable/InRelease"
rm "$work/runner-only"/*_arm64.deb
: > "$work/aws.log"
if bash "$publisher" build "$work/runner-only"; then exit 1; fi
test ! -s "$work/aws.log"
for version in {3..12}; do make_deb paws-runner "1.0.$version" amd64; done
for version in 1.0~rc1 1.0 1.0-1 1:0.1 {2..10}; do make_deb paws-order "$version" amd64; done
bash "$script" build "$work/repo" "$work/incoming"
test "$(for deb in "$work/repo/pool/main/p/paws-runner/"*.deb; do dpkg-deb -f "$deb" Version; done | sort -u | wc -l)" = 10
test -f "$work/repo/pool/main/p/paws-order/paws-order_1:0.1_amd64.deb"
test ! -f "$work/repo/pool/main/p/paws-order/paws-order_1.0-1_amd64.deb"
test ! -f "$work/repo/pool/main/p/paws-runner/paws-runner_1.0.2_amd64.deb"
printf changed >> "$work/incoming/paws-runner_1.0.12_amd64.deb"
if bash "$script" build "$work/repo" "$work/incoming"; then exit 1; fi
output=$(env -i PATH="$PATH" bash "$publisher" build)
[[ "$output" == *'Skipping apt publication'* ]]
echo 'Apt fixture checks passed'
