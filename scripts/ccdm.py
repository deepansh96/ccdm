"""The `ccdm` command. See docs/adr/0008-one-python-lifecycle-cli.md.

Start it through scripts/ccdm or scripts/ccdm.cmd, which find Python and set up
its environment.
"""

from __future__ import annotations

import sys

from ccdmlib.cli import main

if __name__ == "__main__":
    sys.exit(main())
