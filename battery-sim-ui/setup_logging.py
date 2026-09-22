"""Shared logging setup, adapted from the uiservice template.

Configures the root logger and a dedicated `waitress` logger that writes to
the console and does not propagate, so Flask/waitress and QuixStreams log
lines land on stdout in one format.
"""

import logging


def get_logger():
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] [%(levelname)s]: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    logger = logging.getLogger("waitress")
    logger.setLevel(logging.INFO)
    logger.propagate = False

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(
        logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    )
    logger.addHandler(console_handler)

    return logger
