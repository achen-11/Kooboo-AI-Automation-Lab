import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "engines", "site-harvest"))

from siteharvest import cli


class CliTests(unittest.TestCase):
    def test_force_full_run_includes_data_before_render(self):
        state = {"urls": {}}
        args = SimpleNamespace(force=True)
        calls = []

        def stage(name):
            return lambda _args: calls.append(name)

        with patch.object(cli, "cmd_plan", return_value=(state, "/virtual/package")), \
             patch.object(cli, "cmd_discover", side_effect=stage("discover")), \
             patch.object(cli, "cmd_fetch", side_effect=stage("fetch")), \
             patch.object(cli, "cmd_extract", side_effect=stage("extract")), \
             patch.object(cli, "cmd_assets", side_effect=stage("assets")), \
             patch.object(cli, "cmd_data", side_effect=stage("data")), \
             patch.object(cli, "cmd_render", side_effect=stage("render")), \
             patch.object(cli, "load_state", return_value=state), \
             patch.object(cli, "save_state"), \
             patch.object(cli.verify, "run", return_value=([], [])):
            _state, out, blockers = cli.cmd_all(args)

        self.assertEqual(out, "/virtual/package")
        self.assertEqual(blockers, [])
        self.assertEqual(calls, ["discover", "fetch", "extract", "assets", "data", "render"])


if __name__ == "__main__":
    unittest.main()
