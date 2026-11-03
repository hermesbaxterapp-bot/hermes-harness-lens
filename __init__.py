"""Harness Lens agent-plugin entrypoint.

The agent-side registration is intentionally empty; the read-only API lives in
dashboard/plugin_api.py and the Desktop page in desktop/plugin.js.
"""


def register(ctx):  # noqa: D401 - nothing to register on the agent side
    return None
