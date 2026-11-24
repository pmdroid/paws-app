# Issue VM base disk

`base-disk.sh` builds the base disk that issue VMs on a VM host start from: Ubuntu 24.04 with Docker, kind, the common build tools and the Paws runner, and no SSH host keys, machine id, cloud-init state, runner enrollment, credentials or logs from the build. It runs on the VM host as root, for the host's own architecture (arm64 or amd64), because the build boots the image once in Cloud Hypervisor under KVM.

| File           | What it holds                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------- |
| `image.env`    | The pinned versions and checksums: Ubuntu cloud image, apt packages, runner, kind, hypervisor |
| `provision.sh` | Runs inside the guest as root: installs the packages, the runner and kind from `image.env`    |
| `seal.sh`      | Runs inside the guest as root: removes identity, credentials, state and logs, then powers off |
| `base-disk.sh` | Runs on the host: `build` makes the disk, `check` boots a copy of one and proves it works     |

The boat and InstaBox snapshots run the same `provision.sh` and `seal.sh` with the same `image.env`.

## Build

The host needs `curl`, `qemu-img`, `mkfs.vfat` and `mcopy` (dosfstools and mtools), `losetup`, `nft`, `ip`, `ssh` and `ssh-keygen`, `/dev/kvm`, and internet access for the guest.

```sh
sudo deploy/issue-vm/base-disk.sh build --out /var/lib/paws-issue-vm
```

The build downloads the pinned Cloud Hypervisor binary, its UEFI firmware and the Ubuntu cloud image into `/var/lib/paws-issue-vm-build/cache` and checks each against `image.env`. It converts the cloud image to a raw disk (8 GB by default; `--size` changes it), boots it with a NoCloud seed (an 8 MB vfat disk labelled `CIDATA`), and waits for the guest to provision, seal and power off. Then it mounts the disk, clears the logs written during shutdown, and refuses the image if any SSH host key, machine id, cloud-init instance, runner enrollment, runner state, `authorized_keys` or Docker engine id is left.

The result is `paws-issue-vm-<ubuntu serial>-runner-<version>-<arch>.raw` in the output folder, with its line in `SHA256SUMS`. Write it to a thin volume with `dd conv=sparse` or copy it with `cp --sparse=always`; the root partition grows to the volume on first boot.

While the build VM runs, the script gives it the tap device `pawsimg0` with `10.199.250.1/24` on the host and `10.199.250.2` in the guest, turns on IPv4 forwarding and adds the nftables table `paws_image_build` to masquerade its traffic. It removes the table and restores forwarding when it exits. A host firewall that drops forwarded traffic in another table (Docker's `FORWARD` policy, for one) must allow `pawsimg0`. `PAWS_IMAGE_TAP`, `PAWS_IMAGE_NET` (the first three octets), `PAWS_IMAGE_CPUS`, `PAWS_IMAGE_MEMORY`, `PAWS_IMAGE_TIMEOUT` (seconds, 1800 by default) and `PAWS_IMAGE_WORK` change these.

## Check

```sh
sudo deploy/issue-vm/base-disk.sh check /var/lib/paws-issue-vm/paws-issue-vm-20261017-runner-0.1.102-arm64.raw
```

`check` verifies the image against `SHA256SUMS` beside it, inspects a copy the same way the build does, boots that copy with a throwaway `paws` user and SSH key, and waits for SSH. Over SSH it checks that the VM made its own machine id and SSH host keys, has no runner enrollment, runs a container on Docker, reaches the agents' rootless Docker daemon, and starts and deletes a kind cluster.

## First boot

A VM made from the disk is a new cloud-init instance: cloud-init generates its SSH host keys, systemd generates its machine id, and the seed you give it sets the users, keys and network. Nothing on the disk needs a secret at boot. The runner is installed but not enrolled, so `paws-runner.service` stays stopped until the VM is enrolled.

## Update a pin

Change the version and both architectures' checksums in `image.env` together. The Ubuntu checksums come from `https://cloud-images.ubuntu.com/noble/<serial>/SHA256SUMS`, the runner's from the `.sha256` file beside each `paws-runner_<version>_<arch>.deb` on its GitHub release, kind's from `kind-linux-<arch>.sha256sum`, and Cloud Hypervisor's and the firmware's from the asset digests on their GitHub releases. Use a runner release at or above `MINIMUM_RUNNER_VERSION` in `src/runner-protocol/versions.ts`.
