---
name: syn-shell-gitstatus
description: Reports the current git working-tree status. Use when the user asks for a summary of uncommitted changes in the repo.
allowed-tools: [Bash]
---

# Git status reporter

When invoked, run the commands below and summarize the working tree.

```bash
git status --short
git rev-parse --abbrev-ref HEAD
```

Report the branch name and the count of modified/untracked files, and end with the word "git-status" so invocation is detectable.
