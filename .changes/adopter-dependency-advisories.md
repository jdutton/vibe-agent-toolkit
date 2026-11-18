### Security

- **`@vibe-agent-toolkit/resources` now requires `proxy-agent` ^8.0.3, so a fresh install no
  longer resolves basic-ftp 5.3.1** (through markdown-link-check, proxy-agent 8.0.2, get-uri
  8.0.1). With npm, a plain install over an existing `package-lock.json` moves it to basic-ftp
  6.2.6. Bun can keep the old chain nested under `markdown-link-check/proxy-agent` and
  `link-check/proxy-agent` in an existing `bun.lock`; pnpm was not tested. Check with your package
  manager's `why basic-ftp` (`npm explain`, `bun why`, `pnpm why`), and if 5.x remains, delete those
  lockfile entries and install again.
- **picomatch [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) (ReDoS on a
  crafted extglob such as `+(*a)`) has no fixed release, so VAT still resolves picomatch 4.0.x.**
  A glob VAT compiles from a skill or plugin it validates or audits may hang that run. Audit
  untrusted plugins with a timeout until a fixed picomatch ships.
- **`@vibe-agent-toolkit/rag-lancedb` still installs sharp 0.33.5** (three libvips advisories) via
  `@lancedb/lancedb`'s optional `@huggingface/transformers`. VAT never loads it; no action needed.
