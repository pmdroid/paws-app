import importlib.util
import pathlib
import unittest


path = pathlib.Path(__file__).resolve().parents[2] / "deploy/linux/check-witness.py"
specification = importlib.util.spec_from_file_location("witness", path)
witness = importlib.util.module_from_spec(specification)
specification.loader.exec_module(witness)


class WitnessTests(unittest.TestCase):
    def test_setup_dirt_is_preserved_between_commands(self):
        self.assertFalse(witness.new_dirt("existing setup status", "existing setup status"))
        self.assertFalse(witness.new_dirt("existing setup status", ""))
        self.assertTrue(witness.new_dirt("existing setup status", "changed status"))
        self.assertTrue(witness.new_dirt(None, "nonempty status"))
        self.assertTrue(witness.new_dirt("", None))

    def test_binary_output_is_bounded_after_utf8_replacement(self):
        output = witness.Output()
        for _ in range(200):
            output.append(b"\xff" * 8192)
        output.append(b"", final=True)
        self.assertLessEqual(len(output.text().encode("utf-8")), 1048576)
        self.assertTrue(output.truncated)
        output.append(b"x")
        count = len(output.chunks)
        for _ in range(10000):
            output.append(b"x" * 8192)
        self.assertEqual(len(output.chunks), count)

    def test_exact_bounded_nul_output_is_retained(self):
        output = witness.Output()
        output.append(b"\0" * 1048576)
        output.append(b"", final=True)
        self.assertEqual(output.text(), "\0" * 1048576)
        self.assertFalse(output.truncated)


if __name__ == "__main__":
    unittest.main()
