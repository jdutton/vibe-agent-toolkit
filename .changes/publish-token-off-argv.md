### Security

- **`vat claude marketplace publish` put `GH_TOKEN` / `GITHUB_TOKEN` in git's command line, where any
  local user could read it with `ps`.** The token now reaches git through its environment, which
  needs **git 2.31 or newer** when publishing with a token (older git is refused with
  `BACKEND_UNAVAILABLE`), and a `GIT_CONFIG_COUNT` that is not plain decimal is refused with
  `USAGE_INVALID`. Your own `http.https://github.com/.extraheader` is not sent during the publish.

### Fixed

- **`vat claude marketplace publish` could build on, or push to, a ref other than the branch** — the
  history of a remote `refs/heads/refs/heads/<branch>`, or a remote tag of the branch's name. It now
  publishes exactly `refs/heads/<branch>`, and refuses with `CONFIG_INVALID` while the remote holds a
  ref git would take for it (such as `refs/heads/refs/heads/<branch>`): delete or rename that ref.
