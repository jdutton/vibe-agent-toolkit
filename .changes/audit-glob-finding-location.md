### Breaking

- **`vat audit` files `FILES_GLOB_MATCHED_NOTHING` on the declaring `SKILL.md` when the glob's folder
  lies outside the audit root**, the folder (`../packages/x/dist/...`) appended to the message. A
  consumer keyed on the folder location must key on the `SKILL.md` and read the folder from the message.
