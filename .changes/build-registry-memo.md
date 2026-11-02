### Fixed

- **`vat build` could run out of memory on a project with many plugin-local skills** (0.2.0-rc.12):
  validating each packaged skill re-read the whole project and kept every copy. It now reads the
  project once per run. If you raised `--max-old-space-size` to get past this, you can drop it.
