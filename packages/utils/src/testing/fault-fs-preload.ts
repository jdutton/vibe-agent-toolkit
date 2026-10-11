/**
 * `node --import <utils dist>/testing/fault-fs-preload.js <cli dist>/bin.js ...` — the fs fault
 * injector for a SPAWNED process, so a system test can fault the real binary the way the fault
 * matrix faults a verb in-process.
 *
 * It reads `VAT_FAULT_FS` (`{"within": "<dir>", "faults": [{"family", "op", "pathIncludes", "nth",
 * "errno"}]}`, see {@link faultFsSpecOf}) and installs the faults before the program's first
 * module loads. The session lives as long as the process: nothing restores it.
 *
 * Importing this module IS the installation, so it is never re-exported from the `./testing`
 * barrel. With `VAT_FAULT_FS` unset or empty it does nothing.
 *
 * ⛔ Framework-free, like everything under `testing/`.
 */

import { installFaultFs } from './fault-fs.js';
import { faultFsSpecOf, faultRuleOf } from './fault-spec.js';

const text = process.env['VAT_FAULT_FS'];
if (text !== undefined && text !== '') {
  const spec = faultFsSpecOf(text);
  installFaultFs({ within: spec.within, faults: spec.faults.map((fault) => faultRuleOf(fault)) });
}
