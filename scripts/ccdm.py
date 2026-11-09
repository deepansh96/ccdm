"""The `ccdm` command. See docs/adr/0008-one-python-lifecycle-cli.md.

Start it through scripts/ccdm or scripts/ccdm.cmd, which find Python and set up
its environment.
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True  # no __pycache__ beside the scripts; before importing them

from ccdmlib.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
