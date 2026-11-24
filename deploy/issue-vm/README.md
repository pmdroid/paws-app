# Issue VM base disk

`base-disk.sh` builds the base disk that issue VMs on a VM host start from: Ubuntu 24.04 with Docker, kind, the common build tools and the Paws runner, and no SSH host keys, machine id, cloud-init state, runner enrollment, credentials or logs from the build. It runs on the VM host as root, for the host's own architecture (arm64 or amd64), because the build boots the image once in Cloud Hypervisor under KVM.

| File           | What it holds                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------- |
| `image.env`    | The pinned versions and checksums: Ubuntu cloud image, apt packages, runner, kind, hypervisor |
| `provision.sh` | Runs inside the guest as root: sets memory overcommit, installs the packages, runner and kind |
| `seal.sh`      | Runs inside the guest as root: removes identity, credentials, state and logs, then powers off |
| `base-disk.sh` | Runs on the host: `build` makes the disk, `check` boots a copy of one and proves it works     |
| `disk.sh`      | Runs on the host as root: the thin pool and each issue VM's own disk in it                    |

The boat and InstaBox snapshots run the same `provision.sh` and `seal.sh` with the same `image.env`.

## Build

The host needs `curl`, `git`, `qemu-img`, `mkfs.vfat` and `mcopy` (dosfstools and mtools), `losetup`, `nft`, `ip`, `ssh` and `ssh-keygen`, `/dev/kvm`, and internet access for the guest.

```sh
sudo deploy/issue-vm/base-disk.sh build --out /var/lib/paws-issue-vm
```

The build downloads the pinned Cloud Hypervisor binary, its UEFI firmware and the Ubuntu cloud image into `/var/lib/paws-issue-vm-build/cache` and checks each against `image.env`. It converts the cloud image to a raw disk (8 GB by default; `--size` changes it), boots it with a NoCloud seed (an 8 MB vfat disk labelled `CIDATA`), and waits for the guest to provision, seal and power off. Then it mounts the disk, clears the logs written during shutdown, and refuses the image if any SSH host key, machine id, cloud-init instance, runner enrollment, runner state, `authorized_keys` or Docker engine id is left, or if the pinned runner release or the overcommit setting is missing. It reads the runner's release links inside the image, so the host doesn't need that runner release itself.

The result is `paws-issue-vm-<ubuntu serial>-runner-<version>-<arch>.raw` in the output folder, with its line in `SHA256SUMS`. Write it to a thin volume with `dd conv=sparse` or copy it with `cp --sparse=always`; the root partition grows to the volume on first boot.

While the build VM runs, the script gives it the tap device `pawsimg0` with `10.199.250.1/24` on the host and `10.199.250.2` in the guest, turns on IPv4 forwarding and adds the nftables table `paws_image_build` to masquerade its traffic. It removes the table and restores forwarding when it exits. A host firewall that drops forwarded traffic in another table (Docker's `FORWARD` policy, for one) must allow `pawsimg0`. `PAWS_IMAGE_TAP`, `PAWS_IMAGE_NET` (the first three octets), `PAWS_IMAGE_CPUS`, `PAWS_IMAGE_MEMORY`, `PAWS_IMAGE_TIMEOUT` (seconds, 1800 by default) and `PAWS_IMAGE_WORK` change these.

## Check

```sh
sudo deploy/issue-vm/base-disk.sh check /var/lib/paws-issue-vm/paws-issue-vm-20261017-runner-0.1.102-arm64.raw
```

`check` verifies the image against `SHA256SUMS` beside it, inspects a copy the same way the build does, boots that copy with a throwaway `paws` user and SSH key, and waits for SSH. Over SSH it checks that the VM made its own machine id and SSH host keys, has no runner enrollment, runs a container on Docker, reaches the agents' rootless Docker daemon, starts and deletes a kind cluster, and has `vm.overcommit_memory=1`. Then it copies the paws-app checkout the script sits in (its committed `HEAD`) into the VM and runs `bun install --frozen-lockfile` and `bun run knip` there with the runner's Bun, on the default 4 GB VM.

## Disks

Each issue VM gets its own thin snapshot of the base disk, named by its issue VM id, in the LVM volume group `paws-issue-vms`. The group lives on a sparse file, `/var/lib/paws-runner/issue-vms/pool.img`, attached as a loop device. Set up a VM host once, as root, with the pool size in GB and a built base disk:

```sh
install -m 0755 deploy/issue-vm/disk.sh /usr/local/sbin/paws-issue-vm-disk
install -m 0644 deploy/issue-vm/paws-issue-vm-pool.service 'deploy/issue-vm/paws-issue-vm-disk@.service' /etc/systemd/system/
install -m 0644 deploy/issue-vm/paws-issue-vm-disk.polkit /etc/polkit-1/rules.d/60-paws-issue-vm-disk.rules
paws-issue-vm-disk init 400 /var/lib/paws-issue-vm/paws-issue-vm-20261017-runner-0.1.102-arm64.raw
systemctl daemon-reload
systemctl enable paws-issue-vm-pool.service
```

`init` makes the sparse file, the volume group, a thin pool on 95% of it and the read-only volume `base` with the image written sparsely. `paws-issue-vm-pool.service` attaches the file and activates the group at boot, before `paws-runner.service`.

The runner daemon reaches the disks only by starting `paws-issue-vm-disk@<operation>.service`; the polkit rule lets the `paws-runner` user start that unit for these operations and nothing else, and the result is left in `/run/paws-issue-vm-disk/<operation>.out`:

| Operation          | What it does                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `pool`             | The pool's size and the bytes its data uses                                                       |
| `list`             | Each issue VM volume and its size; `base` and the pool are left out                               |
| `create-<id>-<gb>` | Snapshots `base` as `<id>` (`lvcreate -s -K`), grows it to the VM disk size and activates it      |
| `delete-<id>`      | Removes the volume `<id>`; the id must be an issue VM id, so `base` and the pool can't be removed |

The runner makes a new disk only when every existing disk, each VM's memory snapshot (as much disk as its memory) and the new disk with its snapshot fit in 80% of the pool, and the data already written stays under that too. It deletes a volume only when its name is an issue VM on that host in `deleting`. Cloud Hypervisor takes the disk as `--disk path=/dev/paws-issue-vms/<id>,image_type=raw`.

## First boot

A VM made from the disk is a new cloud-init instance: cloud-init generates its SSH host keys, systemd generates its machine id, and the seed you give it sets the users, keys and network. Nothing on the disk needs a secret at boot. `/etc/sysctl.d/90-paws-overcommit.conf` sets `vm.overcommit_memory = 1`: with Ubuntu's default heuristic overcommit, oxc-parser (which knip uses) fails with "Array buffer allocation failed" on a 4 GB VM. The runner is installed but not enrolled, so `paws-runner.service` stays stopped until the VM is enrolled.

## Update a pin

Change the version and both architectures' checksums in `image.env` together. The Ubuntu checksums come from `https://cloud-images.ubuntu.com/noble/<serial>/SHA256SUMS`, the runner's from the `.sha256` file beside each `paws-runner_<version>_<arch>.deb` on its GitHub release, kind's from `kind-linux-<arch>.sha256sum`, and Cloud Hypervisor's and the firmware's from the asset digests on their GitHub releases. Use a runner release at or above `MINIMUM_RUNNER_VERSION` in `src/runner-protocol/versions.ts`.
