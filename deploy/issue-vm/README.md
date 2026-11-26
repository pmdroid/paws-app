# Issue VM base disk

`base-disk.sh` builds the base disk that issue VMs on a VM host start from: Ubuntu 24.04 with Docker, kind, the common build tools and the Paws runner, and no SSH host keys, machine id, cloud-init state, runner enrollment, credentials or logs from the build. It runs on the VM host as root, for the host's own architecture (arm64 or amd64), because the build boots the image once in Cloud Hypervisor under KVM.

| File           | What it holds                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------- |
| `image.env`    | The pinned versions and checksums: Ubuntu cloud image, apt packages, runner, kind, hypervisor |
| `provision.sh` | Runs inside the guest as root: sets memory overcommit, installs the packages, runner and kind |
| `seal.sh`      | Runs inside the guest as root: removes identity, credentials, state and logs, then powers off |
| `base-disk.sh` | Runs on the host: `build` makes the disk, `check` boots a copy of one and proves it works     |
| `disk.sh`      | Runs on the host as root: the thin pool and each issue VM's own disk in it                    |
| `vm.sh`        | Runs in each VM unit on the host: the seed, disk owner and network before Cloud Hypervisor    |

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

The runner daemon reaches the disks only by starting `paws-issue-vm-disk@<operation>.service`; the polkit rule lets the `paws-runner` user start that unit for these operations and nothing else, and the result is left in `/run/paws-issue-vm-disk/<operation>.out`. Operations run one at a time:

| Operation                      | What it does                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `pool`                         | The pool's size and the bytes its data uses                                                                              |
| `list`                         | Each issue VM volume and its size; `base` and the pool are left out                                                      |
| `create-<id>-<gb>-<memory gb>` | Snapshots `base` as `<id>` (`lvcreate -s -K`) tagged with the VM's memory, grows it to the VM disk size and activates it |
| `delete-<id>`                  | Removes the volume `<id>`; the id must be an issue VM id, so `base` and the pool can't be removed                        |

`create` refuses a disk smaller than `base`, and removes a new volume it could not grow or activate; run again on an existing volume, it finishes growing and activating it.

The runner makes a new disk only when every existing disk with its own memory snapshot (as much disk as that VM's memory), and the new disk with its snapshot, fit in 80% of the pool, and the data already written stays under that too. It deletes a volume only when its name is an issue VM on that host in `deleting`. Cloud Hypervisor takes the disk as `--disk path=/dev/paws-issue-vms/<id>,image_type=raw`.

## VMs

Each issue VM runs as one Cloud Hypervisor process in its own unit, `paws-issue-vm@<id>-<slot>-<vcpus>-<memory gb>.service`, under the service user `paws-issue-vm` with only the `kvm` group and `CAP_NET_ADMIN` for its TAP. Set up a VM host once, as root, after the disks, with the Cloud Hypervisor binary and firmware the build fetched:

```sh
install -m 0755 deploy/issue-vm/vm.sh /usr/local/sbin/paws-issue-vm
install -m 0644 deploy/issue-vm/paws-issue-vm.sysusers /etc/sysusers.d/paws-issue-vm.conf
systemd-sysusers
install -d -m 0755 /usr/local/lib/paws-issue-vm
install -d -m 0711 /var/lib/paws-issue-vm-state
install -m 0755 /var/lib/paws-issue-vm-build/cache/cloud-hypervisor-static-aarch64-v54.1 /usr/local/lib/paws-issue-vm/cloud-hypervisor
install -m 0644 /var/lib/paws-issue-vm-build/cache/ch-97eeb7b09-CLOUDHV_EFI.fd /usr/local/lib/paws-issue-vm/firmware.fd
install -m 0644 'deploy/issue-vm/paws-issue-vm@.service' /etc/systemd/system/
install -m 0644 deploy/issue-vm/paws-issue-vm.polkit /etc/polkit-1/rules.d/60-paws-issue-vm.rules
systemctl daemon-reload
```

On amd64 the files are `cloud-hypervisor-static-v54.1` and `ch-97eeb7b09-CLOUDHV.fd`. The host also needs `mkfs.vfat` and `mcopy`.

Before Cloud Hypervisor starts, the unit, as root, refuses a second unit for the same VM or slot, writes the VM's NoCloud seed (instance id `<id>-<slot>`, guest `10.199.<slot>.2`) to the root-owned `/var/lib/paws-issue-vm-state/seed-<id>.img`, gives `paws-issue-vm` the VM's disk, and starts `paws-issue-vm-network@<slot>.service`. Cloud Hypervisor then runs with the disk, the seed, the TAP `pawsvm<slot>`, the size in the unit name, the serial log `serial.log` and the API socket `api.sock` in `/var/lib/paws-issue-vm-state/<id>`. As soon as Cloud Hypervisor holds the seed open, the unit deletes `seed-<id>.img` from the host; the VM keeps reading it through the open file. When it stops, the disk goes back to root and the slot's network rules stop, unless another running unit still holds that VM or slot: a rejected second unit leaves the running VM alone. The polkit rule lets the `paws-runner` user start and stop these units and nothing else.

The VM units are not part of `paws-runner.service`, so they keep running when the runner daemon stops or crashes. When `/etc/systemd/system/paws-issue-vm@.service` exists, the daemon reads the host's slots, VM size and issue VMs from Paws at start and every 30 seconds after, and compares them with the running units. It keeps a VM that is creating, awake or asleep. It stops one that is deleting, unknown, a second unit for the same VM or slot, or past the host's slots; on a runner that is not a VM host in Paws, every VM is unknown. It starts each awake VM that doesn't run in the lowest free slot, and starts none past the host's slots. Before it starts a VM, it asks Paws for that VM's single-use bootstrap token. When Paws gives one, the daemon puts it in `/var/lib/paws-runner/issue-vm-enroll/<id>` (mode `0600`). When Paws has none for the VM, or doesn't offer tokens, the daemon starts the VM without one. When the request fails, it waits for the next pass. The unit takes the file and deletes it, and the seed's cloud-init user data writes the token and the host's `/etc/paws-runner/config.json` into the VM, enrolls the runner as `paws-vm-<id>`, retrying every 15 seconds for the token's 10 minutes, and starts `paws-runner.service`. The user data also gives each of the config's host names its own relay address, `10.199.0.<n>`, in the VM's `/etc/hosts`, so the runner reaches Paws through the host's relay ([network rules](../../docs/runner-enrollment.md#network-rules-for-issue-vms)). Each start, stop and wait for a slot is an `issue_vm_started`, `issue_vm_stopped` or `issue_vm_waiting` line in the runner's journal. To look at them:

```sh
systemctl list-units 'paws-issue-vm@*'
journalctl -u 'paws-issue-vm@*'
journalctl -u paws-runner.service | grep issue_vm_
```

## First boot

A VM made from the disk is a new cloud-init instance: cloud-init generates its SSH host keys, systemd generates its machine id, and the seed you give it sets the users, keys and network. Nothing on the disk needs a secret at boot. `/etc/sysctl.d/90-paws-overcommit.conf` sets `vm.overcommit_memory = 1`: with Ubuntu's default heuristic overcommit, oxc-parser (which knip uses) fails with "Array buffer allocation failed" on a 4 GB VM. The runner is installed but not enrolled, so `paws-runner.service` stays stopped until the seed of a VM host enrolls it.

## Update a pin

Change the version and both architectures' checksums in `image.env` together. The Ubuntu checksums come from `https://cloud-images.ubuntu.com/noble/<serial>/SHA256SUMS`, the runner's from the `.sha256` file beside each `paws-runner_<version>_<arch>.deb` on its GitHub release, kind's from `kind-linux-<arch>.sha256sum`, and Cloud Hypervisor's and the firmware's from the asset digests on their GitHub releases. Use a runner release at or above `MINIMUM_RUNNER_VERSION` in `src/runner-protocol/versions.ts`.
