### Breaking

- **`vat claude marketplace publish` with `GH_TOKEN` / `GITHUB_TOKEN` set and an `https://github.com/`
  remote now needs git 2.31 or newer**; older git is refused with `BACKEND_UNAVAILABLE`. Upgrade git.
- **The publish's token header replaces every extra HTTP header that applies to github.com** — a
  global `http.extraheader` included (a proxy header, a PAT you set). If you authenticate with your
  own header, unset `GH_TOKEN`/`GITHUB_TOKEN` for the publish, or put that token in `GH_TOKEN`.
- **A `GIT_CONFIG_COUNT` that is not plain decimal (`0x2`, `1k`) is refused with `INPUT_UNREADABLE`**
  when a token applies. Set it as plain decimal.
- **An empty `GH_TOKEN` no longer disables token auth: `GITHUB_TOKEN` is used instead.** Unset both
  to publish without a token.

### Security

- **`vat claude marketplace publish` put `GH_TOKEN` / `GITHUB_TOKEN` in git's command line, where any
  local user could read it with `ps`.** The token now reaches git through its environment.

### Fixed

- **`vat claude marketplace publish` could build on, or push to, a ref other than the branch** — the
  history of a remote `refs/heads/refs/heads/<branch>`, or a remote tag of the branch's name. It now
  publishes exactly `refs/heads/<branch>`, and refuses with `INPUT_UNREADABLE` while the remote holds
  a ref git would take for it (such as `refs/heads/refs/heads/<branch>`): delete or rename that ref.
