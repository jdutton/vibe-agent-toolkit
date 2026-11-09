### Security

- **`vat claude marketplace publish` put `GH_TOKEN` / `GITHUB_TOKEN` in git's command line, where any
  local user could read it with `ps`.** The token now reaches git as an HTTP auth header through git's
  environment configuration; no action needed.
