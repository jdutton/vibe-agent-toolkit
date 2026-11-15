### Fixed

- **A parse thread that started and then crashed could fail the whole scan as a broken VAT
  install** (`Cannot load VAT's markdown parser module`), most often on a loaded machine. The
  crash is now judged once the thread has exited. Fixed; no action needed.
