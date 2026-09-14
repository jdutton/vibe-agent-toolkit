/**
 * `dirent-type-needs-symlink-check` — `isFile()` / `isDirectory()` on a
 * Dirent are both false for a symlink, so a walk that asks only those two
 * silently drops every link. The VALID cases pin every way a binding can be
 * proven to be a Dirent AND checked; the INVALID ones pin every way the same
 * binding can reach the type test unchecked — including the shapes the rule
 * must NOT confuse with a Stats object from `stat()`.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'dirent-type-needs-symlink-check';
const ERR = [{ messageId: 'direntTypeWithoutSymlinkCheck' }];
const READDIR = 'const entries = readdirSync(dir, { withFileTypes: true });';
const AREADDIR = 'const entries = await readdir(dir, { withFileTypes: true });';

const CASES: RuleCases = {
  valid: [
    // The check is made on the same binding, so a link is decided explicitly.
    { code: `${READDIR} for (const e of entries) { if (e.isSymbolicLink()) { refuse(e); } else if (e.isDirectory()) { walk(e); } }` },
    { code: `${AREADDIR} for (const e of entries) { if (e.isSymbolicLink() || e.isFile()) { keep(e); } }` },
    { code: `${READDIR} const dirs = entries.filter((e) => !e.isSymbolicLink() && e.isDirectory());` },
    { code: 'for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.isSymbolicLink()) continue; if (e.isFile()) read(e); }' },
    { code: 'for await (const e of opendir(dir)) { if (e.isSymbolicLink()) continue; if (e.isFile()) read(e); }' },
    { code: 'function walk(entry: Dirent) { if (entry.isSymbolicLink()) return; if (entry.isDirectory()) recurse(entry); }' },
    { code: 'function walk(entries: Dirent[]) { for (const e of entries) { if (e.isSymbolicLink()) continue; if (e.isFile()) read(e); } }' },
    // A Stats object is not a Dirent: `stat()` already followed the link.
    { code: 'const st = statSync(p); if (st.isFile()) read(p);' },
    { code: 'const st = await stat(p); if (st.isDirectory()) walk(p);' },
    { code: 'const st = lstatSync(p); if (st.isDirectory()) walk(p);' },
    // Names alone, without withFileTypes, are strings and have no type methods.
    { code: 'const names = readdirSync(dir); for (const n of names) { if (n.isFile()) read(n); }' },
    { code: 'const names = readdirSync(dir, { withFileTypes: false }); names.filter((n) => n.isFile());' },
    // A Dirent never type-tested is fine.
    { code: `${READDIR} const names = entries.map((e) => e.name);` },
    // Chained, and guarded on the same binding.
    { code: 'const dirs = readdirSync(dir, { withFileTypes: true }).filter((e) => !e.isSymbolicLink() && e.isDirectory());' },
    // A chain that no longer carries Dirents: `map` produced names.
    { code: 'const names = readdirSync(dir, { withFileTypes: true }).map((e) => e.name).filter((n) => n.isFile());' },
  ],
  invalid: [
    { code: `${READDIR} for (const e of entries) { if (e.isDirectory()) { walk(e); } }`, errors: ERR },
    { code: `${AREADDIR} return entries.filter((e) => e.isDirectory()).map((e) => e.name);`, errors: ERR },
    // Both tests, neither guarded: two reports.
    { code: `${READDIR} for (const e of entries) { if (e.isDirectory()) walk(e); else if (e.isFile()) read(e); }`, errors: [...ERR, ...ERR] },
    // Direct iteration over the call.
    { code: 'for (const child of readdirSync(dir, { withFileTypes: true })) { if (child.isFile()) read(child); }', errors: ERR },
    { code: 'for await (const child of opendir(dir)) { if (child.isFile()) read(child); }', errors: ERR },
    // Every array method that hands the element to a callback.
    { code: `${READDIR} entries.some((e) => e.isFile());`, errors: ERR },
    { code: `${READDIR} entries.forEach((e) => { if (e.isDirectory()) walk(e); });`, errors: ERR },
    { code: `${READDIR} const first = entries.find((e) => e.isFile());`, errors: ERR },
    // Assigned later rather than at declaration.
    { code: 'let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { throw e; } for (const d of entries) { if (d.isDirectory()) walk(d); }', errors: ERR },
    // Namespaced call.
    { code: 'const entries = fs.readdirSync(dir, { withFileTypes: true }); for (const e of entries) { if (e.isFile()) read(e); }', errors: ERR },
    { code: 'const entries = await fs.promises.readdir(dir, { withFileTypes: true }); for (const e of entries) { if (e.isFile()) read(e); }', errors: ERR },
    // Typed parameters: the type says Dirent, so the rule knows without seeing the readdir.
    { code: 'function keep(entry: Dirent) { return entry.isFile(); }', errors: ERR },
    { code: 'function walk(entries: Dirent[]) { for (const e of entries) { if (e.isDirectory()) recurse(e); } }', errors: ERR },
    { code: 'function walk(entries: readonly Dirent[]) { return entries.filter((e) => e.isFile()); }', errors: ERR },
    { code: 'function walk(entries: Array<Dirent>) { return entries.filter((e) => e.isFile()); }', errors: ERR },
    // The symlink check is on a DIFFERENT binding, so this one is still unguarded.
    { code: `${READDIR} for (const e of entries) { const st = lstatSync(e.name); if (st.isSymbolicLink()) continue; if (e.isDirectory()) walk(e); }`, errors: ERR },
    // The chained one-liner — the commonest shape, and the one the rule was
    // blind to while its header claimed a callback was covered: eight live
    // sites passed at `error`.
    { code: 'const dirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());', errors: ERR },
    { code: 'const dirs = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);', errors: ERR },
    { code: 'return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).filter((e) => e.isFile());', errors: [...ERR, ...ERR] },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
