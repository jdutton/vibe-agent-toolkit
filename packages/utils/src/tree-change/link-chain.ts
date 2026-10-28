/**
 * The ONE resolver of a symbolic-link chain: where a path leads, walked hop by hop from what
 * `lstat` and `readlink` say alone, so nothing is handed to the kernel until the whole chain has
 * been read as text and shown to be local.
 *
 * That order is the point. A Windows kernel asked to resolve a path through a link to
 * `\\host\share` opens an SMB session and offers the operator's NTLM credentials to that host
 * before any answer comes back — so a `realpath` or a `stat` that follows links is a SECOND lock,
 * asked only once this walk has proved the chain local, never the first.
 *
 * Pure: the caller supplies the path {@link PathFlavor} and the probe, so a test runs Windows
 * semantics on any host. The flavor decides two things the kernel decides:
 *
 * - what separates a link text's components, and what makes it absolute or a network path
 *   (`\\host\share`, `\\?\UNC\…`, `\\.\…`, `//host/share` under win32; on POSIX a backslash is a
 *   character of a name and `//x` is the local root);
 * - what `..` means. POSIX resolves a link before the `..` after it, physically (the parent of
 *   where the link LED). Windows joins a relative link text onto the link's directory and collapses
 *   every `..` lexically before reparsing — `x\..\y` is `y` whether `x` exists, is a file or a link —
 *   so under win32 each splice is collapsed by string first, and every component it leaves is examined.
 *
 * Running out of hops ({@link MAX_LINK_HOPS}) is a refusal, never an answer: a chain the walk did
 * not finish reading is a chain the kernel would finish for it. A CYCLE is different, and is told
 * apart exactly: the walk meets the same link with the same text left to read, so every text in
 * the cycle has been read and is local, and the kernel can only answer `ELOOP` — it resolves to
 * nothing, as a dangling link does, in every lane.
 *
 * An untrusted tree ({@link ChainRule.outside} `refuse`) may be read on either host — a clone made
 * here is installed there — so its every link text is also held to the OTHER flavor's rules
 * ({@link untrustedTextRefusal}): a text that is absolute, drive-relative or a network path on
 * either kernel is refused on both.
 */

import { posix } from 'node:path';

import { toForwardSlashAnyPlatform } from '../path-core.js';

/** What stands at a place, a link there NOT followed. */
export type PlaceKind = 'directory' | 'file' | 'link' | 'absent';

/** Whose path rules a link's text is read by. Bound from `process.platform` at the edge ({@link HOST_PATH_FLAVOR}). */
export type PathFlavor = 'posix' | 'win32';

/** The flavor of the host VAT runs on — the edge where a pure caller's flavor is bound. */
export const HOST_PATH_FLAVOR: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix';

/**
 * How many links one resolution follows before it refuses. Windows' limit — 63 reparse points in
 * one path — is the larger of the two kernels' (Linux's `MAXSYMLINKS` is 40), so no chain a kernel
 * would still follow is ever cut short and answered.
 */
export const MAX_LINK_HOPS = 63;

/** Why a chain is refused before the kernel is asked anything, with the link whose text decided it. */
export type ChainRefusal =
  /** A network or device path, at any hop: never handed to the kernel, in any lane. */
  | { readonly why: 'network'; readonly link: string; readonly text: string }
  /** An absolute local text, in a tree whose links may not leave it ({@link ChainRule.outside} `refuse`). */
  | { readonly why: 'absolute'; readonly link: string; readonly text: string }
  /** A drive-relative text (`C:x`): it names a place relative to a per-drive working directory no walk can know. */
  | { readonly why: 'drive-relative'; readonly link: string; readonly text: string }
  /** A step above the tree's root, in a tree whose links may not leave it. */
  | { readonly why: 'climbs-out'; readonly link: string; readonly text: string }
  /** More than {@link MAX_LINK_HOPS} links that are not a cycle: a chain longer than either kernel follows. */
  | { readonly why: 'hop-limit'; readonly link: string };

/** Where a chain leads, as far as text can tell. */
export type LinkChain =
  /** A local path, every link on the way read: the kernel may now be asked about it. */
  | { readonly kind: 'resolved'; readonly path: string; readonly final: 'directory' | 'file' }
  /**
   * It leads to nothing: a component is absent or a file stands where a directory must
   * (`absent`), or the chain comes back to a link it already read with the same text left
   * (`cycle` — what the kernel answers `ELOOP` for).
   */
  | { readonly kind: 'nothing'; readonly at: string; readonly cause: 'absent' | 'cycle' }
  /** It may not be resolved at all. */
  | { readonly kind: 'refused'; readonly refusal: ChainRefusal };

/** The tree a chain is resolved in, and what it may do outside it. */
export interface ChainRule {
  readonly flavor: PathFlavor;
  /** The tree's root, canonical (its own components are real directories). */
  readonly root: string;
  /**
   * - `refuse`: an untrusted tree (a clone, an archive, a tree an install copies) — an absolute or
   *   drive-relative text, or any step above the root, is refused, and nothing outside is probed.
   * - `follow`: the user's own tree — an absolute local text is followed and walked by the same
   *   rules, so a later hop's network text is still caught; where the chain ends is the caller's call.
   */
  readonly outside: 'refuse' | 'follow';
}

/** What the walk may ask the filesystem: never anything that follows a link. */
export interface ChainProbe {
  /** What stands at `path`, a link there NOT followed (`lstat`). */
  readonly kindAt: (path: string) => PlaceKind;
  /** The text of the link at `path` (`readlink`). */
  readonly textAt: (path: string) => string;
}

/** A path split into the root it hangs from and its components. */
interface Rooted {
  /** `/`, or a drive root `C:/`. */
  readonly prefix: string;
  readonly parts: readonly string[];
}

/** How a text reads under a flavor: rooted, relative, or one the walk never resolves. */
type TextForm =
  | { readonly form: 'rooted'; readonly rooted: Rooted }
  | { readonly form: 'relative'; readonly parts: readonly string[] }
  | { readonly form: 'network' }
  | { readonly form: 'drive-relative' };

/** `\\?\C:\…` / `\\.\C:\…`, slashes already forward: a local drive through the Win32 namespace. */
const WIN32_NAMESPACED_DRIVE = /^\/\/[?.]\/([A-Za-z]:)(?:\/|$)/;
/** `\\?\Volume{GUID}\…`, slashes already forward: a local volume by its GUID, as a junction or mount point names one. */
const WIN32_VOLUME = /^\/\/\?\/(Volume\{[0-9A-Fa-f-]+\})(?:\/|$)/;
/** `\\host\share\…` / `\\?\UNC\host\share\…`, slashes already forward: the share a NAMED path (never a link's text) hangs from. */
const WIN32_SHARE_ROOT = /^\/\/(?:\?\/UNC\/)?([^/?.][^/]*\/[^/]+)(?:\/|$)/i;
const WIN32_DRIVE_ROOT = /^([A-Za-z]:)(?:\/|$)/;
const WIN32_DRIVE_RELATIVE = /^[A-Za-z]:/;

/** The non-empty, non-`.` components of `text`, spelled with POSIX separators (a win32 text is converted first). */
function partsOf(text: string): string[] {
  return text.split(posix.sep).filter((part) => part !== '' && part !== '.');
}

const DRIVE_RELATIVE = 'drive-relative';
const CLIMBS_OUT = 'climbs-out';

/**
 * How `text` reads under `flavor`.
 *
 * @param text - A path or a link's text
 * @param flavor - Whose rules
 * @param drive - The drive root a win32 rooted-but-driveless text (`\x`) hangs from: the current place's
 */
function textForm(text: string, flavor: PathFlavor, drive: string): TextForm {
  if (flavor === 'posix') {
    return text.startsWith('/') ? { form: 'rooted', rooted: { prefix: '/', parts: partsOf(text) } } : { form: 'relative', parts: partsOf(text) };
  }
  const slashed = toForwardSlashAnyPlatform(text);
  const namespaced = WIN32_NAMESPACED_DRIVE.exec(slashed);
  if (namespaced?.[1] !== undefined) return { form: 'rooted', rooted: { prefix: `${namespaced[1].toUpperCase()}/`, parts: partsOf(slashed.slice(namespaced[0].length)) } };
  const volume = WIN32_VOLUME.exec(slashed);
  if (volume?.[1] !== undefined) return { form: 'rooted', rooted: { prefix: `//?/${volume[1]}/`, parts: partsOf(slashed.slice(volume[0].length)) } };
  if (slashed.startsWith('//')) return { form: 'network' };
  const driveRoot = WIN32_DRIVE_ROOT.exec(slashed);
  if (driveRoot?.[1] !== undefined) return { form: 'rooted', rooted: { prefix: `${driveRoot[1].toUpperCase()}/`, parts: partsOf(slashed.slice(driveRoot[0].length)) } };
  if (WIN32_DRIVE_RELATIVE.test(slashed)) return { form: DRIVE_RELATIVE };
  if (slashed.startsWith('/')) return { form: 'rooted', rooted: { prefix: drive, parts: partsOf(slashed) } };
  return { form: 'relative', parts: partsOf(slashed) };
}

/**
 * How a NAMED path (the start or the root — what the operator or VAT spelled, never a link's text)
 * reads: as {@link textForm}, except that under win32 a share is a root it may hang from. A tree on
 * `\\host\share` is the operator's choice; a link's text naming one is never followed.
 */
function anchoredForm(path: string, flavor: PathFlavor, drive: string): TextForm {
  const form = textForm(path, flavor, drive);
  if (form.form !== 'network') return form;
  const slashed = toForwardSlashAnyPlatform(path);
  const share = WIN32_SHARE_ROOT.exec(slashed);
  if (share?.[1] === undefined) return form;
  return { form: 'rooted', rooted: { prefix: `//${share[1]}/`, parts: partsOf(slashed.slice(share[0].length)) } };
}

/**
 * The root a NAMED path hangs from — `/`, a drive's `C:/`, a share's `//host/share/` — for a walk
 * of the user's own path, which may lead anywhere local.
 *
 * @param path - Absolute, forward- or back-slashed
 * @param flavor - Whose rules
 * @throws TypeError for a path that is not absolute under `flavor`
 */
export function namedPathRoot(path: string, flavor: PathFlavor): string {
  const form = anchoredForm(path, flavor, '/');
  if (form.form !== 'rooted') throw new TypeError(`namedPathRoot: not an absolute local path: ${path}`);
  return form.rooted.prefix;
}

const FLAVORS: readonly PathFlavor[] = ['posix', 'win32'];

/**
 * Why a link text in an UNTRUSTED tree is refused by its text alone, under EITHER flavor — the rule
 * a chain in a `refuse` tree is held to at every hop, and the one a caller that has only the text
 * (a git clone reading link blobs before checkout) asks directly.
 *
 * @param text - A link's text, verbatim
 * @returns `network`, `absolute` or `drive-relative` when either kernel would read it so; `undefined` for a relative text
 */
export function untrustedTextRefusal(text: string): 'network' | 'absolute' | 'drive-relative' | undefined {
  const forms = new Set(FLAVORS.map((flavor) => textForm(text, flavor, '/').form));
  if (forms.has('network')) return 'network';
  if (forms.has(DRIVE_RELATIVE)) return DRIVE_RELATIVE;
  if (forms.has('rooted')) return 'absolute';
  return undefined;
}

/** Collapse `..` by string, never above the root — what Windows does to a name before it reparses it. */
function collapsed(parts: readonly string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out;
}

/** `prefix` + `parts`, forward-slashed. */
function joined(prefix: string, parts: readonly string[]): string {
  return prefix + parts.join('/');
}

/** Whether `path` is `root` or below it — case-blind under win32, as its filesystems compare names. */
function isWithin(path: string, root: string, flavor: PathFlavor): boolean {
  const [p, r] = flavor === 'win32' ? [path.toLowerCase(), root.toLowerCase()] : [path, root];
  const base = r.endsWith('/') ? r : `${r}/`;
  return p === r || p.startsWith(base);
}

/** The walk's position: the root it hangs from, the real directories below it, and what is left to read. */
interface Walk {
  /** The tree's root: its components are real directories, never probed again. */
  readonly base: Rooted;
  prefix: string;
  done: string[];
  pending: string[];
  /** The last link followed and its text — what a refusal names — or the start itself before any. */
  link: string;
  text: string;
}

/**
 * Splice a link's text into the walk in place of the link (already popped from `done`), as
 * `flavor`'s kernel would; or the refusal of a text it never resolves.
 */
function splice(walk: Walk, link: string, text: string, rule: ChainRule): ChainRefusal | undefined {
  walk.link = link;
  walk.text = text;
  const form = textForm(text, rule.flavor, walk.prefix);
  if (form.form === 'network') return { why: 'network', link, text };
  if (form.form === 'drive-relative') return { why: DRIVE_RELATIVE, link, text };
  if (rule.outside === 'refuse') {
    const why = untrustedTextRefusal(text);
    if (why !== undefined) return { why, link, text };
  }
  if (form.form === 'rooted') {
    if (rule.flavor === 'win32') return rebase(walk, form.rooted.prefix, collapsed([...form.rooted.parts, ...walk.pending]), rule);
    walk.prefix = form.rooted.prefix;
    walk.pending = [...form.rooted.parts, ...walk.pending];
    walk.done = [];
    return undefined;
  }
  if (rule.flavor === 'win32') {
    // Joined onto the link's directory and collapsed by string BEFORE anything is looked at, then
    // re-walked: a `..` never asks what the component before it is.
    return rebase(walk, walk.prefix, collapsed([...walk.done, ...form.parts, ...walk.pending]), rule);
  }
  walk.pending = [...form.parts, ...walk.pending];
  return undefined;
}

/**
 * Re-walk the whole name `prefix` + `parts` (a win32 splice, already collapsed): from the tree's
 * root when the name is below it — the root's own components are real directories — else from the
 * name's own root, which only a tree whose links may leave it allows.
 */
function rebase(walk: Walk, prefix: string, parts: string[], rule: ChainRule): ChainRefusal | undefined {
  const { base } = walk;
  if (isWithin(joined(prefix, parts), joined(base.prefix, base.parts), rule.flavor)) {
    walk.prefix = base.prefix;
    walk.done = [...base.parts];
    walk.pending = parts.slice(base.parts.length);
    return undefined;
  }
  if (rule.outside === 'refuse') return { why: CLIMBS_OUT, link: walk.link, text: walk.text };
  walk.prefix = prefix;
  walk.done = [];
  walk.pending = parts;
  return undefined;
}

/** The walk's starting position for `start`: from the root when `start` is below it, else from its own root. */
function startOf(start: string, rule: ChainRule, rootParts: Rooted): Walk | ChainRefusal {
  const form = anchoredForm(start, rule.flavor, rootParts.prefix);
  if (form.form === 'network') return { why: 'network', link: start, text: start };
  if (form.form !== 'rooted') return { why: DRIVE_RELATIVE, link: start, text: start };
  const parts = rule.flavor === 'win32' ? collapsed(form.rooted.parts) : [...form.rooted.parts];
  const path = joined(form.rooted.prefix, parts);
  const root = joined(rootParts.prefix, rootParts.parts);
  if (isWithin(path, root, rule.flavor) && (rule.flavor === 'win32' || !parts.includes('..'))) {
    return { base: rootParts, prefix: rootParts.prefix, done: [...rootParts.parts], pending: parts.slice(rootParts.parts.length), link: start, text: start };
  }
  if (rule.outside === 'refuse') return { why: CLIMBS_OUT, link: start, text: start };
  return { base: rootParts, prefix: form.rooted.prefix, done: [], pending: parts, link: start, text: start };
}

/**
 * Where `start` leads, every link on the way read by its text before anything follows it.
 *
 * @param start - An absolute path, in `rule.flavor`'s spelling (forward or back slashes)
 * @param rule - The flavor, the tree, and what the chain may do outside it
 * @param probe - `lstat` and `readlink`, and nothing that follows a link
 * @returns The local path the kernel may now be asked about, nothing, or the refusal
 * @throws whatever `probe` throws: a probe the OS refused is the caller's to classify
 */
export function walkLinkChain(start: string, rule: ChainRule, probe: ChainProbe): LinkChain {
  const rootForm = anchoredForm(rule.root, rule.flavor, '/');
  if (rootForm.form !== 'rooted') throw new TypeError(`walkLinkChain: the root must be a local absolute path, not ${rule.root}`);
  const root = joined(rootForm.rooted.prefix, rootForm.rooted.parts);
  const begun = startOf(start, rule, rootForm.rooted);
  if ('why' in begun) return { kind: 'refused', refusal: begun };
  const walk = begun;
  let final: 'directory' | 'file' = 'directory';
  // Each link met, with the text still to read after it: meeting one again is a cycle, exactly.
  const followed: Followed = { met: new Set<string>(), hops: 0 };
  for (let part = walk.pending.shift(); part !== undefined; part = walk.pending.shift()) {
    const step = stepTo(walk, part, rule, root, probe);
    if (step.kind !== 'step') return step;
    if (step.stands === 'link') {
      const ended = followLink(walk, rule, probe, followed);
      if (ended !== undefined) return ended;
    } else {
      final = step.stands;
    }
  }
  return { kind: 'resolved', path: joined(walk.prefix, walk.done), final };
}

/** What stands at the walk's place after one component, when the walk goes on. */
type Step = { readonly kind: 'step'; readonly stands: 'directory' | 'file' | 'link' } | LinkChain;

/**
 * Take one component: the kind that now stands at the walk's place (a `..` is a directory — the
 * parent of a real directory), or the answer that ends the walk.
 */
function stepTo(walk: Walk, part: string, rule: ChainRule, root: string, probe: ChainProbe): Step {
  if (part === '..') walk.done.pop();
  else walk.done.push(part);
  const here = joined(walk.prefix, walk.done);
  if (rule.outside === 'refuse' && !isWithin(here, root, rule.flavor)) return { kind: 'refused', refusal: { why: CLIMBS_OUT, link: walk.link, text: walk.text } };
  if (part === '..') return { kind: 'step', stands: 'directory' };
  const kind = probe.kindAt(here);
  if (kind === 'absent' || (kind === 'file' && walk.pending.length > 0)) return { kind: 'nothing', at: here, cause: 'absent' };
  return { kind: 'step', stands: kind };
}

/** The links a walk has followed: each with the text left after it, and how many hops in all. */
interface Followed {
  readonly met: Set<string>;
  hops: number;
}

/**
 * Follow the link at the walk's place by its text: a cycle when this link was already met with the
 * same text left to read, the hop limit's refusal past {@link MAX_LINK_HOPS} links, the text's own
 * refusal, or `undefined` to walk on. The hop count bounds the walk on its own, cycle or not.
 */
function followLink(walk: Walk, rule: ChainRule, probe: ChainProbe, followed: Followed): LinkChain | undefined {
  const here = joined(walk.prefix, walk.done);
  const state = `${here}\0${walk.pending.join('/')}`;
  followed.hops += 1;
  if (followed.met.has(state)) return { kind: 'nothing', at: here, cause: 'cycle' };
  followed.met.add(state);
  if (followed.hops > MAX_LINK_HOPS) return { kind: 'refused', refusal: { why: 'hop-limit', link: here } };
  walk.done.pop();
  const refusal = splice(walk, here, probe.textAt(here), rule);
  return refusal === undefined ? undefined : { kind: 'refused', refusal };
}
