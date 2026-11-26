import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace


ASSETS = pathlib.Path(sys.argv[1])


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), ASSETS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def link(name, *entries):
    return {"ifname": name, "addr_info": [{"family": "inet", "local": local, "prefixlen": length} for local, length in entries]}


LINKS = [
    link("lo", ("127.0.0.1", 8)),
    link("eth0", ("198.51.200.7", 24)),
    link("tailscale0", ("100.101.102.103", 32)),
    link("pawsvm1", ("10.199.1.1", 24)),
    link("wide", ("44.1.2.3", 9)),
]
ROUTES = [{"dst": "default", "gateway": "198.51.200.1", "dev": "eth0"}, {"dst": "default", "dev": "tailscale0"}]


class FakeHost:
    def __init__(self, links, routes, docker=True):
        self.links = links
        self.routes = routes
        self.docker = docker
        self.docker_rules = []
        self.calls = []
        self.applied = []

    def tool(self, arguments, check=True, stdin=None):
        self.calls.append(arguments)
        if arguments[:2] == ["ip", "-j"]:
            return SimpleNamespace(returncode=0, stdout=json.dumps(self.routes if "route" in arguments else self.links))
        if arguments == ["nft", "-f", "-"]:
            self.applied.append(stdin)
            return SimpleNamespace(returncode=0, stdout="")
        if arguments[:3] == ["nft", "delete", "table"]:
            self.applied.append(None)
            return SimpleNamespace(returncode=0, stdout="")
        if arguments[0] == "iptables":
            if not self.docker:
                raise FileNotFoundError("iptables")
            operation, rule = arguments[3], arguments[5:]
            if operation == "-S":
                return SimpleNamespace(returncode=0, stdout="-N DOCKER-USER\n-A DOCKER-USER -j RETURN\n" + "".join("-A DOCKER-USER " + " ".join(rule) + "\n" for rule in self.docker_rules))
            if operation == "-I":
                self.docker_rules.insert(0, rule)
            if operation == "-D":
                self.docker_rules.remove(rule)
            return SimpleNamespace(returncode=0, stdout="")
        raise AssertionError(f"unexpected tool {arguments}")


class Rules(unittest.TestCase):
    def setUp(self):
        self.network = load("issue-vm-network")

    def test_slots_name_one_tap_and_one_subnet_each(self):
        self.assertEqual(self.network.addresses(7), {"tap": "pawsvm7", "host": "10.199.7.1", "guest": "10.199.7.2", "mask": "255.255.255.0"})
        self.assertEqual(self.network.slot_number("254"), 254)
        for bad in ("0", "255", "01", "1a", "", "-1", "1 "):
            with self.assertRaises(ValueError):
                self.network.slot_number(bad)

    def test_the_rules_deny_private_and_host_destinations_and_ipv6(self):
        ruleset, outward = self.network.render([3, 1], LINKS, ROUTES)
        self.assertEqual(outward, ["eth0"])
        lines = [line.strip() for line in ruleset.splitlines()]
        elements = next(line for line in lines if line.startswith("elements"))
        for denied in ("10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/3", "198.51.200.0/24", "44.1.2.3/32"):
            self.assertIn(denied, elements)
        self.assertNotIn("44.0.0.0/9", elements)
        self.assertNotIn("10.199", elements)
        for rule in (
            'iifname "pawsvm*" ct state established,related accept',
            'iifname "pawsvm*" meta nfproto ipv6 drop',
            'oifname "pawsvm*" meta nfproto ipv6 drop',
            'iifname "pawsvm1" ip saddr != 10.199.1.2 drop',
            'iifname "pawsvm3" ip saddr != 10.199.3.2 drop',
            'oifname "pawsvm3" ip daddr != 10.199.3.2 drop',
            'iifname "pawsvm*" ip daddr @denied4 drop',
            'iifname "pawsvm*" oifname != "eth0" drop',
            'oifname "pawsvm*" iifname != "eth0" drop',
            "ip saddr 10.199.0.0/16 oifname \"eth0\" masquerade",
        ):
            self.assertIn(rule, lines)
        self.assertEqual(lines.index('iifname "pawsvm*" drop'), lines.index('iifname "pawsvm*" ct state established,related accept') + 1)
        self.assertLess(lines.index('iifname "pawsvm*" ip daddr @denied4 drop'), lines.index('oifname "pawsvm*" ct state established,related accept'))
        self.assertEqual(lines[-7:], ['oifname "pawsvm*" drop', "}", "chain postrouting {", "type nat hook postrouting priority 110; policy accept;", 'ip saddr 10.199.0.0/16 oifname "eth0" masquerade', "}", "}"])
        self.assertEqual(lines[:3], ["table inet paws_issue_vms", "delete table inet paws_issue_vms", "table inet paws_issue_vms {"])
        self.assertIn("type filter hook input priority -10; policy accept;", lines)
        self.assertIn("type filter hook forward priority -10; policy accept;", lines)

    def test_without_a_default_route_issue_vms_reach_nothing(self):
        ruleset, outward = self.network.render([1], LINKS, [{"dst": "default", "dev": "tailscale0"}])
        self.assertEqual(outward, [])
        forward = ruleset.split("chain forward {")[1].split("}")[0]
        self.assertEqual([line.strip() for line in forward.splitlines() if line.strip()][-2:], ['iifname "pawsvm*" drop', 'oifname "pawsvm*" drop'])
        self.assertNotIn("masquerade", ruleset)
        self.assertNotIn("oifname !=", ruleset)

    def test_the_relay_forwards_only_the_paws_runner_urls_over_the_tailnet(self):
        config = pathlib.Path(tempfile.mkdtemp()) / "config.json"
        config.write_text(json.dumps({"controlPlaneUrl": "https://paws.example.ts.net:8787", "runnerApiUrl": "https://paws.example.ts.net:8788/v1", "agentUser": "paws-agent"}))
        resolve = lambda host, port, *rest: [(2, 1, 6, "", ({"paws.example.ts.net": "100.90.1.2", "api.example.ts.net": "100.90.1.3"}[host], port))] if host.endswith(".ts.net") else []
        relay = self.network.paws_relay(config, resolve)
        self.assertEqual(relay, [("10.199.0.1", "100.90.1.2", 8787), ("10.199.0.1", "100.90.1.2", 8788)])
        config.write_text(json.dumps({"controlPlaneUrl": "ftp://paws.example.ts.net", "runnerApiUrl": "https://elsewhere:9000"}))
        self.assertEqual(self.network.paws_relay(config, resolve), [])
        self.assertEqual(self.network.paws_relay(config.parent / "missing.json", resolve), [])
        ruleset, _ = self.network.render([1], LINKS, ROUTES, relay)
        lines = [line.strip() for line in ruleset.splitlines()]
        accept = lines.index('iifname "pawsvm*" ip daddr 100.90.1.2 tcp dport 8788 accept')
        self.assertLess(accept, lines.index('iifname "pawsvm*" ip daddr @denied4 drop'))
        self.assertLess(lines.index('oifname "pawsvm*" ip saddr 100.90.1.2 tcp sport 8787 ct state established accept'), lines.index('oifname "pawsvm*" iifname != "eth0" drop'))
        for rule in ('iifname "pawsvm*" ip daddr 10.199.0.1 tcp dport 8787 dnat ip to 100.90.1.2', "ip saddr 10.199.0.0/16 ip daddr 100.90.1.2 tcp dport 8788 masquerade", 'iifname "pawsvm*" drop'):
            self.assertIn(rule, lines)
        self.assertEqual(sum("dport" in line for line in lines), 8)
        self.assertLess(lines.index('iifname "pawsvm*" ip daddr 100.90.1.2 tcp dport 8787 accept'), lines.index('iifname "pawsvm*" drop'))
        self.assertNotIn("100.64.0.0/10 accept", ruleset)

    def test_two_https_servers_on_443_each_keep_their_own_forward(self):
        config = pathlib.Path(tempfile.mkdtemp()) / "config.json"
        config.write_text(json.dumps({"controlPlaneUrl": "https://paws.example.ts.net", "runnerApiUrl": "https://api.example.ts.net"}))
        resolve = lambda host, port, *rest: [(2, 1, 6, "", ({"paws.example.ts.net": "100.90.1.2", "api.example.ts.net": "100.90.1.3"}[host], port))]
        relay = self.network.paws_relay(config, resolve)
        self.assertEqual(relay, [("10.199.0.1", "100.90.1.3", 443), ("10.199.0.2", "100.90.1.2", 443)])
        ruleset, _ = self.network.render([1], LINKS, ROUTES, relay)
        self.assertIn('iifname "pawsvm*" ip daddr 10.199.0.1 tcp dport 443 dnat ip to 100.90.1.3', ruleset)
        self.assertIn('iifname "pawsvm*" ip daddr 10.199.0.2 tcp dport 443 dnat ip to 100.90.1.2', ruleset)
        self.assertEqual(self.network.relay_hosts(self.network.paws_endpoints(config)), {"api.example.ts.net": "10.199.0.1", "paws.example.ts.net": "10.199.0.2"})

    def test_every_default_route_device_is_an_uplink(self):
        ruleset, outward = self.network.render([1], LINKS, [*ROUTES, {"dst": "default", "dev": "wlan0", "metric": 600}, {"dst": "default", "dev": "pawsvm2"}])
        self.assertEqual(outward, ["eth0", "wlan0"])
        self.assertIn('iifname "pawsvm*" oifname != { "eth0", "wlan0" } drop', ruleset)
        self.assertIn('ip saddr 10.199.0.0/16 oifname { "eth0", "wlan0" } masquerade', ruleset)


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.network = load("issue-vm-network")
        self.temporary = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temporary.name)
        self.state = root / "network"
        self.network.FORWARD_SWITCH = root / "ip_forward"
        self.network.LOCK = root / "network.lock"
        self.network.STATE = self.state
        self.network.CONFIG = root / "config.json"

    def tearDown(self):
        self.temporary.cleanup()

    def host(self, **options):
        fake = FakeHost(LINKS, ROUTES, **options)
        self.network.tool = fake.tool
        return fake

    def test_rules_come_with_the_first_vm_and_go_with_the_last(self):
        fake = self.host()
        result = self.network.up(2, self.state)
        self.assertEqual(result, {"vms": [2], "uplinks": ["eth0"], "docker": True, "relay": []})
        self.assertIn('iifname "pawsvm2" ip saddr != 10.199.2.2 drop', fake.applied[-1])
        self.assertEqual(self.network.FORWARD_SWITCH.read_text(), "1\n")
        self.assertEqual(sorted(map(tuple, fake.docker_rules)), sorted(map(tuple, self.network.docker_rules(["eth0"]))))
        self.network.up(5, self.state)
        self.assertIn('iifname "pawsvm5" ip saddr != 10.199.5.2 drop', fake.applied[-1])
        self.assertEqual(len(fake.docker_rules), 2)
        self.assertEqual(self.network.down(2, self.state)["vms"], [5])
        self.assertNotIn("pawsvm2", fake.applied[-1])
        self.assertEqual(self.network.down(5, self.state), {"vms": [], "uplinks": [], "docker": True, "relay": []})
        self.assertIsNone(fake.applied[-1])
        self.assertEqual(fake.docker_rules, [])
        self.assertEqual(self.network.down(5, self.state)["vms"], [])

    def test_a_host_address_or_uplink_change_rewrites_the_rules(self):
        fake = self.host()
        self.network.up(1, self.state)
        fake.links = [*LINKS[:1], link("eth1", ("203.0.200.9", 24))]
        fake.routes = [{"dst": "default", "dev": "eth1"}]
        self.assertEqual(self.network.apply(self.state)["uplinks"], ["eth1"])
        self.assertIn("203.0.200.0/24", fake.applied[-1])
        self.assertNotIn("198.51.200.0/24", fake.applied[-1])
        self.assertIn('iifname "pawsvm*" oifname != "eth1" drop', fake.applied[-1])
        self.assertEqual(sorted(map(tuple, fake.docker_rules)), sorted(map(tuple, self.network.docker_rules(["eth1"]))))

    def test_the_relay_follows_the_runner_config(self):
        fake = self.host()
        self.network.CONFIG.write_text(json.dumps({"controlPlaneUrl": "https://100.90.1.2:8787", "runnerApiUrl": "https://100.90.1.2:8788"}))
        self.assertEqual(self.network.up(1, self.state)["relay"], ["10.199.0.1:8787>100.90.1.2", "10.199.0.1:8788>100.90.1.2"])
        self.assertIn("dnat ip to 100.90.1.2", fake.applied[-1])
        self.assertEqual(len(fake.docker_rules), 6)

    def test_a_host_without_docker_needs_no_docker_rules(self):
        fake = self.host(docker=False)
        self.assertEqual(self.network.up(1, self.state)["docker"], False)
        self.assertEqual(len(fake.applied), 1)

    def test_main_takes_only_known_commands(self):
        self.host()
        self.assertEqual(self.network.main(["up"]), 2)
        self.assertEqual(self.network.main(["reset"]), 2)
        with self.assertRaises(ValueError):
            self.network.main(["up", "300"])
        self.assertEqual(self.network.main(["up", "4"]), 0)
        self.assertEqual(self.network.active_slots(self.state), [4])
        self.assertEqual(self.network.main(["down", "4"]), 0)
        self.assertEqual(self.network.active_slots(self.state), [])


class Packaging(unittest.TestCase):
    def test_the_helper_and_its_units_ship_with_the_runner(self):
        installer = load("install")
        for name in ("issue-vm-network.py", "paws-issue-vm-network@.service", "paws-issue-vm-network.service"):
            self.assertIn(name, installer.release.ASSETS)
        self.assertIsNone(installer.asset_target("issue-vm-network.py"))
        self.assertEqual(installer.asset_target("paws-issue-vm-network@.service"), pathlib.Path("/etc/systemd/system/paws-issue-vm-network@.service"))
        unit = (ASSETS / "paws-issue-vm-network@.service").read_text()
        for needed in ("Type=oneshot", "RemainAfterExit=yes", "issue-vm-network.py up %i", "issue-vm-network.py down %i", "Wants=paws-issue-vm-network.service"):
            self.assertIn(needed, unit)
        self.assertIn("issue-vm-network.py watch", (ASSETS / "paws-issue-vm-network.service").read_text())


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]], verbosity=1)
