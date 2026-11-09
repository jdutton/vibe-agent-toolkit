### Security

- **`vat claude marketplace publish` put `GH_TOKEN` / `GITHUB_TOKEN` in git's command line, where any
  local user could read it with `ps`.** The token now reaches git as an HTTP auth header through git's
  environment configuration; no action needed.

### Fixed

- **`vat claude marketplace publish` could build on, or push to, a ref other than the branch.** With
  the branch absent it could build on an unrelated ref such as `refs/heads/refs/heads/<branch>`, and
  its push could target a remote tag of the branch's name. It now reads, builds on and pushes exactly
  `refs/heads/<branch>`; a same-named tag is never touched. No action needed.
