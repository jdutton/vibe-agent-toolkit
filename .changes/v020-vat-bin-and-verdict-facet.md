### Breaking

- **`VAT_ROOT_DIR` naming a tree with no built CLI (`packages/cli/dist/bin.js`) now exits 2**
  with a message instead of silently falling through to the local install. Likewise a `VAT_BIN`
  that does not exist, or that names the wrapper itself (`dist/bin/vat.js`).

### Added

- **`VAT_BIN`** — an explicit `bin.js` path for the `vat` wrapper, highest precedence
  (`VAT_BIN` > `VAT_ROOT_DIR` > dev-mode > local install > global install).
