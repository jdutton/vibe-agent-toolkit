### Fixed

- **A parse thread that crashed while idle could still be handed the next document, or be kept
  for the next pool, in the moment before Node reported its exit.** The document was then run again
  on another thread, or the next pool inherited a dead thread. A thread is now set aside as soon as
  it reports its crash, and its death is still judged once it has exited. Fixed; no action needed.
