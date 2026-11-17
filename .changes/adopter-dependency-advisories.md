### Security

- **`@vibe-agent-toolkit/resources` now requires `proxy-agent` ^8.0.3, so an install no longer
  resolves basic-ftp 5.3.1** (through markdown-link-check, get-uri 8.0.1). A plain install moves an
  existing lockfile to basic-ftp 6.2.6; no other action needed.
- **picomatch [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) (ReDoS on a
  crafted extglob such as `+(*a)`) has no fixed release, so VAT still resolves picomatch 4.0.x.**
  A glob VAT compiles from a skill or plugin it validates or audits may hang that run. Audit
  untrusted plugins with a timeout until a fixed picomatch ships.
- **`@vibe-agent-toolkit/rag-lancedb` still installs sharp 0.33.5** (three libvips advisories) via
  `@lancedb/lancedb`'s optional `@huggingface/transformers`. VAT never loads it; no action needed.
