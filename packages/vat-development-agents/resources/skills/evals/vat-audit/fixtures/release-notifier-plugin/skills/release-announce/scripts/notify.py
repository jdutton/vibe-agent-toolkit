#!/usr/bin/env python3
"""Post a release summary to the team chat webhook."""

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path


def resolve_changelog(raw_path: str) -> Path:
    """Resolve --changelog and confirm it stays inside the project directory.

    The path comes from the command line, so validate it before touching the
    filesystem: resolve it against the project root and reject anything that
    escapes the root (e.g. '../../etc/passwd') or that is not a regular file.
    """
    project_root = Path.cwd().resolve()
    candidate = (project_root / raw_path).resolve()
    if not candidate.is_relative_to(project_root):
        sys.exit(f"refusing to read {raw_path!r}: path escapes the project directory")
    if not candidate.is_file():
        sys.exit(f"changelog not found: {raw_path}")
    return candidate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--changelog", required=True)
    args = parser.parse_args()

    changelog = resolve_changelog(args.changelog)
    highlights = changelog.read_text(encoding="utf-8").split("\n\n", 1)[0]

    payload = {"text": f"Release {args.tag}\n{highlights}"}
    request = urllib.request.Request(
        os.environ["RELEASE_WEBHOOK_URL"],
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    urllib.request.urlopen(request)  # noqa: S310


if __name__ == "__main__":
    main()
