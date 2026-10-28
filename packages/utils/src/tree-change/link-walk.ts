/**
 * Where a symbolic link's text leads, decided by WALKING it — the rule for a link in a tree that
 * will be RELOCATED (an install copies the tree, each link's text verbatim). Pure: the caller says
 * what stands at each place.
 *
 * A lexical resolve cancels `x/..` without asking what `x` is, so `l -> up/../../../secret` beside
 * `up -> ../..` reads as inside the tree while the kernel follows `up` first and lands three
 * levels above it. And where such a link dangles at the source, its real path proves nothing: it
 * resolves once the tree is copied somewhere those levels exist. So nothing is assumed:
 *
 * - the text is relative — an absolute one points at the same place wherever the copy lands;
 * - walked one segment at a time from the link's own directory, the place never rises above the
 *   tree's root — not even to come back in by the tree's own name, which the copy may not keep;
 * - no component the walk passes THROUGH is a link: a link may point at something, never through
 *   another link, whose own text decides where the rest of the walk goes;
 * - the place it ends at exists. A link that dangles is refused, because nothing can be proved
 *   about where it lands after the copy.
 *
 * The walk is a MODEL of the kernel's resolution, and a model can be wrong (it once split a text
 * on a backslash the POSIX kernel reads as part of a name). So its caller holds two more locks
 * beside it — the one link-chain resolver (`link-chain.ts`), which reads the chain from the link to
 * its end before anything follows it, and then the kernel's own resolution of the link at the
 * source — and a link is kept only when all three agree.
 */

import type { PathFlavor, PlaceKind } from './link-chain.js';

/** Why a link's text is refused, with the place (root-relative, `/`-joined) the walk stopped at. */
export type LinkTextRefusal =
  | { readonly why: 'absolute' }
  | { readonly why: 'climbs-out' }
  | { readonly why: 'through-link'; readonly at: string }
  | { readonly why: 'dangling'; readonly at: string };

/**
 * What separates the components of a link's text is the answer of the kernel that resolves it,
 * not VAT's. On POSIX only `/` does — a backslash is an ordinary character of a name, so `a\b` is
 * one component, and reading it as two would count a `..` the kernel never takes.
 */
const SEPARATOR: Readonly<Record<PathFlavor, RegExp>> = { posix: /\//, win32: /[/\\]/ };
/** A POSIX root, a UNC root or a drive prefix: absolute, or drive-relative, on some host. */
const ABSOLUTE = /^([/\\]|[A-Za-z]:)/;

/** The components of a link's text, as `flavor` splits it: `.` and empty ones dropped. */
function segmentsOf(text: string, flavor: PathFlavor): string[] {
  return text.split(SEPARATOR[flavor]).filter((segment) => segment !== '' && segment !== '.');
}

/**
 * Walk a link's text from the directory the link is in.
 *
 * @param linkDir - The link's REAL directory, as segments below the tree's root (`[]`: the root itself)
 * @param text - The link's text, verbatim
 * @param kindAt - What stands at a place below the root, never following a link there
 * @param flavor - Whose kernel resolves the link: its separators split the text
 * @returns `undefined` when the text leads to something that exists inside the tree, by a walk
 *   that passes through no link; otherwise why it is refused
 */
export function linkTextRefusal(linkDir: readonly string[], text: string, kindAt: (place: readonly string[]) => PlaceKind, flavor: PathFlavor): LinkTextRefusal | undefined {
  if (ABSOLUTE.test(text)) return { why: 'absolute' };
  const segments = segmentsOf(text, flavor);
  const place = [...linkDir];
  for (const [index, segment] of segments.entries()) {
    if (segment === '..') {
      // Every place the walk stands at is a real directory of the tree, so its parent is `place` less one.
      if (place.pop() === undefined) return { why: 'climbs-out' };
      continue;
    }
    place.push(segment);
    const kind = kindAt(place);
    const last = index === segments.length - 1;
    if (kind === 'absent' || (!last && kind === 'file')) return { why: 'dangling', at: place.join('/') };
    if (!last && kind === 'link') return { why: 'through-link', at: place.join('/') };
  }
  return undefined;
}
