"""Import bootstrap for the ``backend-api`` test modules.

Quix builds every application from its own folder, so the modules under test are
top-level (``import canonical``, not ``import backend_api.canonical``) and there is
no package to install. Putting the parent directory on ``sys.path`` once, here,
keeps every test module free of the ``sys.path`` prelude that ``test_db.py`` has to
carry - and keeps the imports at the top of the file where the linter wants them.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FIXTURES = Path(__file__).resolve().parent / "fixtures"
