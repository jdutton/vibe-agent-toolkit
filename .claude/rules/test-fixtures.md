---
paths:
  - "**/test/fixtures/**"
  - "**/test/**/fixtures/**"
---

# A committed fixture never uses a gitignored name

`dist/`, `node_modules/`, `coverage/` and `build/` are gitignored repo-wide, so a fixture that
uses one of those names is silently skipped by `git add`: the tests pass on the author's machine
and fail in every clean clone. Store the committed source under a non-ignored name (for example
`build-artifacts/`) and copy it into place in `beforeAll`. (not enforced)

Fixture sizing, storage and extraction:
[`docs/writing-tests.md`](../../docs/writing-tests.md#test-fixtures). A fixture must be able to
distinguish the behaviour under test from its absence — a friendly fixture is the first drift
class a review looks for ([drift class 5](../../docs/contributing/drift-classes.md#5-a-check-that-cannot-fail));
`hostile-tree.ts` in `@vibe-agent-toolkit/utils/testing` is the shared hostile one.
