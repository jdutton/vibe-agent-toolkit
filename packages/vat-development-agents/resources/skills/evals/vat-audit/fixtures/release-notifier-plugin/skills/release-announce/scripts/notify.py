#!/usr/bin/env python3
"""Post a release summary to the team chat webhook."""

import argparse
import json
import os
import urllib.request


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--changelog", required=True)
    args = parser.parse_args()

    with open(args.changelog, encoding="utf-8") as handle:
        highlights = handle.read().split("\n\n", 1)[0]

    payload = {"text": f"Release {args.tag}\n{highlights}"}
    request = urllib.request.Request(
        os.environ["RELEASE_WEBHOOK_URL"],
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    urllib.request.urlopen(request)  # noqa: S310


if __name__ == "__main__":
    main()
