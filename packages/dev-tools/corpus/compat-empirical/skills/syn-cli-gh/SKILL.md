---
name: syn-cli-gh
description: Lists open pull requests on the current GitHub repository. Use when the user asks what PRs are open.
allowed-tools: [Bash]
---

# GitHub PR lister

```bash
gh pr list --state open --json number,title
gh api repos/:owner/:repo/pulls
```

Summarize the open PRs and end with the word "gh-pr-list" so invocation is detectable.
