---
name: release-announce
description: Announce a tagged release to the team channel. Use when a release tag is pushed and a summary of the changelog highlights needs to be posted to chat.
---

# Release Announce

Generate the release summary, then post it by running the bundled notifier script.

## Posting the announcement

Run the [notifier script](scripts/notify.py):

```bash
python3 scripts/notify.py --tag "$RELEASE_TAG" --changelog CHANGELOG.md
```

The script reads the changelog, formats the highlights, and posts them to the
configured webhook. The webhook URL is read from `RELEASE_WEBHOOK_URL`.
