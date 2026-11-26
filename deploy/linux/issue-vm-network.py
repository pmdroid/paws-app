import fcntl
import ipaddress
import json
import pathlib
import re
import select
import socket
import subprocess
import sys
import time
import urllib.parse


TABLE = "paws_issue_vms"
TAP_PREFIX = "pawsvm"
VM_NETWORK = ipaddress.IPv4Network("10.199.0.0/16")
STATE = pathlib.Path("/run/paws-issue-vms/network")
LOCK = pathlib.Path("/run/paws-issue-vms/network.lock")
FORWARD_SWITCH = pathlib.Path("/proc/sys/net/ipv4/ip_forward")
TOOL_PATH = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"}
DENIED4 = (
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/3",
)
NOT_UPLINK = re.compile(r"(?:lo|pawsvm.*|tailscale.*|docker.*|br-.*|veth.*|virbr.*)\Z")
INTERFACE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._@-]{0,14}\Z")
SLOT = re.compile(r"[1-9][0-9]{0,2}\Z")
DOCKER_CHAIN = "DOCKER-USER"
CONFIG = pathlib.Path("/etc/paws-runner/config.json")
DEFAULT_PORTS = {"https": 443, "http": 80}
HOSTNAME = re.compile(r"[a-z0-9][a-z0-9.-]{0,252}\Z")


def paws_endpoints(config=None):
    try:
        loaded = json.loads((config or CONFIG).read_text())
    except (OSError, ValueError):
        return []
    found = set()
    for key in ("controlPlaneUrl", "runnerApiUrl"):
        value = loaded.get(key) if isinstance(loaded, dict) else None
        try:
            url = urllib.parse.urlsplit(value) if isinstance(value, str) else None
            port = (url.port or DEFAULT_PORTS.get(url.scheme)) if url else None
        except ValueError:
            continue
        if port and url.hostname and HOSTNAME.match(url.hostname):
            found.add((url.hostname, port))
    return sorted(found)


def relay_hosts(endpoints):
    return {host: str(VM_NETWORK.network_address + index + 1) for index, host in enumerate(sorted({host for host, _ in endpoints}))}


def paws_relay(config=None, resolve=socket.getaddrinfo):
    endpoints = paws_endpoints(config)
    hosts = relay_hosts(endpoints)
    relay = []
    for host, port in endpoints:
        try:
            entries = resolve(host, port, socket.AF_INET, socket.SOCK_STREAM)
        except OSError:
            continue
        if entries:
            relay.append((hosts[host], entries[0][4][0], port))
    return relay


def slot_number(value):
    if not SLOT.match(value) or not 1 <= int(value) <= 254:
        raise ValueError("Issue VM slot must be a number from 1 to 254")
    return int(value)


def addresses(slot):
    return {
        "tap": f"{TAP_PREFIX}{slot}",
        "host": str(VM_NETWORK.network_address + slot * 256 + 1),
        "guest": str(VM_NETWORK.network_address + slot * 256 + 2),
        "mask": "255.255.255.0",
    }


def tool(arguments, check=True, stdin=None):
    return subprocess.run(arguments, input=stdin, capture_output=True, text=True, env=TOOL_PATH, timeout=30, check=check)


def uplinks(routes):
    found = []
    for route in routes:
        device = route.get("dev")
        if route.get("dst") != "default" or not isinstance(device, str) or not INTERFACE.match(device) or NOT_UPLINK.match(device):
            continue
        if device not in found:
            found.append(device)
    return found


def host_prefixes(links):
    prefixes = set()
    for link in links:
        for entry in link.get("addr_info", []):
            if entry.get("family") != "inet" or not isinstance(entry.get("local"), str):
                continue
            address = ipaddress.IPv4Address(entry["local"])
            if address in VM_NETWORK:
                continue
            length = entry.get("prefixlen")
            length = length if isinstance(length, int) and 16 <= length <= 32 else 32
            prefixes.add(ipaddress.IPv4Network(f"{address}/{length}", strict=False))
            prefixes.add(ipaddress.IPv4Network(f"{address}/32"))
    return prefixes


def interfaces(names):
    return json.dumps(names[0]) if len(names) == 1 else "{ " + ", ".join(json.dumps(name) for name in names) + " }"


def render(slots, links, routes, relay=()):
    vms = sorted(set(slots))
    targets = sorted({(address, port) for _, address, port in relay})
    outward = uplinks(routes)
    denied = [str(network) for network in ipaddress.collapse_addresses([*map(ipaddress.IPv4Network, DENIED4), *host_prefixes(links)])]
    forward = [
        f'iifname "{TAP_PREFIX}*" meta nfproto ipv6 drop',
        f'oifname "{TAP_PREFIX}*" meta nfproto ipv6 drop',
        *(f'iifname "{addresses(slot)["tap"]}" ip saddr != {addresses(slot)["guest"]} drop' for slot in vms),
        *(f'oifname "{addresses(slot)["tap"]}" ip daddr != {addresses(slot)["guest"]} drop' for slot in vms),
        *(f'iifname "{TAP_PREFIX}*" ip daddr {address} tcp dport {port} accept' for address, port in targets),
        *(f'oifname "{TAP_PREFIX}*" ip saddr {address} tcp sport {port} ct state established accept' for address, port in targets),
        f'iifname "{TAP_PREFIX}*" ip daddr @denied4 drop',
    ]
    if outward:
        forward += [
            f'iifname "{TAP_PREFIX}*" oifname != {interfaces(outward)} drop',
            f'oifname "{TAP_PREFIX}*" iifname != {interfaces(outward)} drop',
            f'oifname "{TAP_PREFIX}*" ct state established,related accept',
            f'oifname "{TAP_PREFIX}*" drop',
        ]
    else:
        forward += [f'iifname "{TAP_PREFIX}*" drop', f'oifname "{TAP_PREFIX}*" drop']
    postrouting = [f"ip saddr {VM_NETWORK} oifname {interfaces(outward)} masquerade"] if outward else []
    postrouting += [f"ip saddr {VM_NETWORK} ip daddr {address} tcp dport {port} masquerade" for address, port in targets]
    prerouting = [f'iifname "{TAP_PREFIX}*" ip daddr {local} tcp dport {port} dnat ip to {address}' for local, address, port in relay]
    lines = [
        f"table inet {TABLE}",
        f"delete table inet {TABLE}",
        f"table inet {TABLE} {{",
        "  set denied4 {",
        "    type ipv4_addr; flags interval",
        "    elements = { " + ", ".join(denied) + " }",
        "  }",
        "  chain prerouting {",
        "    type nat hook prerouting priority -100; policy accept;",
        *(f"    {rule}" for rule in prerouting),
        "  }",
        "  chain input {",
        "    type filter hook input priority -10; policy accept;",
        f'    iifname "{TAP_PREFIX}*" ct state established,related accept',
        *(f'    iifname "{TAP_PREFIX}*" ct status dnat ip daddr {address} tcp dport {port} accept' for address, port in targets),
        f'    iifname "{TAP_PREFIX}*" drop',
        "  }",
        "  chain forward {",
        "    type filter hook forward priority -10; policy accept;",
        *(f"    {rule}" for rule in forward),
        "  }",
        "  chain postrouting {",
        "    type nat hook postrouting priority 110; policy accept;",
        *(f"    {rule}" for rule in postrouting),
        "  }",
        "}",
    ]
    return "\n".join(lines) + "\n", outward


def docker_rules(outward, relay=()):
    rules = []
    for address, port in sorted({(address, port) for _, address, port in relay}):
        rules.append(["-d", f"{address}/32", "-i", f"{TAP_PREFIX}+", "-p", "tcp", "-m", "tcp", "--dport", str(port), "-j", "ACCEPT"])
        rules.append(["-s", f"{address}/32", "-o", f"{TAP_PREFIX}+", "-p", "tcp", "-m", "tcp", "--sport", str(port), "-m", "conntrack", "--ctstate", "ESTABLISHED", "-j", "ACCEPT"])
    for uplink in outward:
        rules.append(["-i", f"{TAP_PREFIX}+", "-o", uplink, "-j", "ACCEPT"])
        rules.append(["-i", uplink, "-o", f"{TAP_PREFIX}+", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"])
    return rules


def existing_docker_rules(listing):
    found = []
    for line in listing.splitlines():
        parts = line.split()
        if parts[:2] == ["-A", DOCKER_CHAIN] and f"{TAP_PREFIX}+" in parts:
            found.append(parts[2:])
    return found


def sync_docker(outward, relay=()):
    try:
        listing = tool(["iptables", "-w", "5", "-S", DOCKER_CHAIN], check=False)
    except FileNotFoundError:
        return False
    if listing.returncode != 0:
        return False
    present = existing_docker_rules(listing.stdout)
    wanted = docker_rules(outward, relay)
    for rule in present:
        if rule not in wanted:
            tool(["iptables", "-w", "5", "-D", DOCKER_CHAIN, *rule])
    for rule in wanted:
        if rule not in present:
            tool(["iptables", "-w", "5", "-I", DOCKER_CHAIN, *rule])
    return True


def active_slots(state=None):
    state = state or STATE
    if not state.is_dir():
        return []
    return sorted(int(path.name) for path in state.iterdir() if SLOT.match(path.name) and 1 <= int(path.name) <= 254)


def host_state():
    links = json.loads(tool(["ip", "-j", "-4", "address", "show"]).stdout or "[]")
    routes = json.loads(tool(["ip", "-j", "-4", "route", "show", "default"]).stdout or "[]")
    return links, routes


def apply(state=None):
    state = state or STATE
    slots = active_slots(state)
    if not slots:
        tool(["nft", "delete", "table", "inet", TABLE], check=False)
        return {"vms": [], "uplinks": [], "docker": sync_docker([]), "relay": []}
    links, routes = host_state()
    relay = paws_relay()
    ruleset, outward = render(slots, links, routes, relay)
    tool(["nft", "-f", "-"], stdin=ruleset)
    if outward or relay:
        FORWARD_SWITCH.write_text("1\n")
    docker = sync_docker(outward, relay)
    return {"vms": slots, "uplinks": outward, "docker": docker, "relay": [f"{local}:{port}>{address}" for local, address, port in relay]}


def locked(action):
    LOCK.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with LOCK.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        return action()


def up(slot, state=None):
    state = state or STATE
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    (state / str(slot)).touch()
    return apply(state)


def down(slot, state=None):
    state = state or STATE
    (state / str(slot)).unlink(missing_ok=True)
    return apply(state)


def watch(interval=60, quiet=1.0):
    locked(apply)
    monitor = subprocess.Popen(["ip", "-4", "monitor", "address", "route"], stdout=subprocess.PIPE, env=TOOL_PATH)
    try:
        while True:
            ready, _, _ = select.select([monitor.stdout], [], [], interval)
            if ready:
                if not monitor.stdout.readline():
                    raise RuntimeError("ip monitor stopped")
                deadline = time.monotonic() + quiet
                while (left := deadline - time.monotonic()) > 0 and select.select([monitor.stdout], [], [], left)[0]:
                    if not monitor.stdout.readline():
                        raise RuntimeError("ip monitor stopped")
            print(json.dumps(locked(apply)), flush=True)
    finally:
        monitor.kill()


def main(arguments):
    if len(arguments) == 2 and arguments[0] in ("up", "down"):
        slot = slot_number(arguments[1])
        result = locked(lambda: (up if arguments[0] == "up" else down)(slot))
        print(json.dumps({**result, **addresses(slot)}))
        return 0
    if arguments == ["apply"]:
        print(json.dumps(locked(apply)))
        return 0
    if arguments == ["watch"]:
        watch()
        return 0
    if len(arguments) == 2 and arguments[0] == "hosts":
        for host, local in relay_hosts(paws_endpoints(pathlib.Path(arguments[1]))).items():
            print(f"{local} {host}")
        return 0
    print("usage: issue-vm-network.py up|down <slot> | apply | watch | hosts <config>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
