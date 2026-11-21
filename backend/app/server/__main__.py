"""CLI entry point for launching the YouDub FastAPI server."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn

from .api import create_app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="YouDub FastAPI runtime backend")
    parser.add_argument("--host", default=os.getenv("YOUDUB_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("YOUDUB_PORT", "8765")))
    parser.add_argument("--config-dir", type=Path, default=None)
    parser.add_argument("--data-dir", type=Path, default=None)
    parser.add_argument("--web-dist", type=Path, default=None)
    args = parser.parse_args(argv)

    if args.data_dir is not None:
        os.environ["YOUDUB_DATA_DIR"] = str(args.data_dir.expanduser().resolve())
    if args.config_dir is not None:
        os.environ["YOUDUB_CONFIG_DIR"] = str(args.config_dir.expanduser().resolve())

    app = create_app(config_dir=args.config_dir, web_dist=args.web_dist)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
