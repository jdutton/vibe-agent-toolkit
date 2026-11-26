/**
 * Where the skills lane gets a markdown document's skill-text record and the
 * facts it reads beside it: from the run's store when it serves the file
 * (`ResourcePopulationSource.storedDocument`), else from the file's text — and
 * then it counts that, once per file per run: a store miss
 * (`skillText.storeMiss`) when the run has a store to ask, else
 * `skillText.noStore` (`ResourcePopulationSource.holdsStore`).
 *
 * Every skills-lane detector is a constructor over the record (the skill-text
 * core's output, `skillTextFactsOf`), so a document's findings are one function
 * of its record, its frontmatter and its location whichever way the record
 * came: from the store on a warm run, from the SKILL.md's parse or the core over
 * a bundled file's text otherwise.
 */

import { basename } from 'node:path';

import {
  isPlainUtf8Decoding,
  MARKDOWN_BY_CONTRACT,
  NO_GIT_MEMBERS,
  type ParseDispatcher,
  readContentForParse,
  type ResourceLink,
  type ResourcePopulationSource,
  RunContentCache,
  SKILL_TEXT_DECLARATION,
  skillTextFactsOf,
  type SkillTextFacts,
  withParseDispatcher,
} from '@vibe-agent-toolkit/resources';
import { countWork, type FsSide, safePath, type TextProvenance, withFsFault } from '@vibe-agent-toolkit/utils';

/**
 * The run a skills-lane read belongs to: the population source that answers
 * from the store and says whether the run has one, the dispatcher a cold
 * parse runs on, and the run's one crawl of each skill discovery base. A
 * `RunPopulation`, and a `RunSkillRegistries`, are each one.
 */
export interface SkillTextRun {
  readonly source: Pick<ResourcePopulationSource, 'storedDocument' | 'holdsStore'>;
  readonly dispatcher: ParseDispatcher;
  /**
   * The run's one content reader, which its dispatcher parses through: a lane that reads a file's
   * bytes beside its parse (a linked file's raw scan, the implicit-reference scan) reads through it,
   * so a member is read once per run, from git in a run that reads members from git, from disk in
   * any other.
   */
  readonly content: RunContentCache;
  /**
   * One skill discovery crawl per key per run: the first caller's `crawl`, its rejection included,
   * handed to every later caller of the key. A run's phases discover the same include bases (`vat
   * validate`'s resources phase, for the skills' declared `files:`, and its skills phase), and
   * each crawl lists its base with git: the same arguments in the same directory over the same tree.
   *
   * @param key - The crawl's identity: everything its result depends on
   * @param crawl - The crawl
   * @returns The run's one result for `key`
   */
  crawlOnce(key: string, crawl: () => Promise<readonly string[]>): Promise<readonly string[]>;
}

/** A source with no store: every file is the lane's own to read, each scan a `skillText.noStore`. */
const NO_STORE: SkillTextRun['source'] = { storedDocument: () => Promise.resolve(undefined), holdsStore: false };

/**
 * Run `work` on `run`, or, for a caller with no run (`undefined`), on a run of
 * its own: a dispatcher held for the call and no store, so every file is read.
 *
 * @param work - The lane's work
 * @param run - The run, or `undefined`
 * @returns Whatever `work` returned
 */
export function withSkillTextRun<T>(work: (run: SkillTextRun) => Promise<T>, run: SkillTextRun | undefined): Promise<T> {
  if (run !== undefined) return work(run);
  // A run of one call: nothing to share a crawl with, so each crawls; no store, so no member reads
  // from git, and its dispatcher parses through its own content reader.
  const content = new RunContentCache(NO_GIT_MEMBERS);
  return withParseDispatcher(
    (dispatcher) => work({ source: NO_STORE, dispatcher, content, crawlOnce: (_key, crawl) => crawl() }),
    { policy: { content } },
  );
}

/** How a document's bytes were decoded: what the store's `blobs` row and a read's `KeyedContent` both say. */
export type SkillDocumentDecoding = Pick<TextProvenance, 'encoding' | 'encodingSource'>;

/**
 * A SKILL.md as the skills lane reads it: the ONE mapping from a document's
 * facts, stored or parsed, that discovery, the packaging lane and the skill
 * validator each read. The frontmatter verdict is the parse's whole one, so a
 * lane words its refusal from it and the record's `frontmatterFence`
 * (`frontmatterVerdictOf`) without reading the file.
 */
export interface SkillDocument {
  readonly frontmatter: Record<string, unknown> | undefined;
  readonly frontmatterError: string | undefined;
  /** Whether the block is valid YAML but not a mapping. */
  readonly frontmatterNotAMapping: boolean;
  /** Each link's shape (never its resolution), in document order, with its line when the parse knew it. */
  readonly links: ReadonlyArray<Pick<ResourceLink, 'href' | 'type' | 'line'>>;
  readonly skillText: SkillTextFacts;
  /** How its bytes were decoded, which {@link linkedFileSkillText} decides by. */
  readonly decoding: SkillDocumentDecoding;
  /**
   * Its decoded text, for a detector that needs the bytes: the read the parse
   * was made from, or, for a document the store served, a read made only when
   * called (the run's content read, decoded as a cold read is, counted as
   * `content.read`).
   */
  readonly text: () => Promise<string>;
}

/** One file a run's lane scanned from text: the text, and the record the core built from it. */
interface ScannedFile {
  readonly text: string;
  readonly facts: SkillTextFacts;
}

/**
 * The files each run's lane has scanned from text, by the run's one parse
 * dispatcher (every lane of a run shares it): one count per file per run, and
 * the record of the text last scanned, so a second skill reaching the same file
 * with the same text is handed the record rather than scanning it again.
 */
const scannedByRun = new WeakMap<ParseDispatcher, Map<string, ScannedFile | undefined>>();

/**
 * The run's scanned-file table.
 *
 * @param dispatcher - The run's dispatcher
 * @returns Its table
 */
function scannedOf(dispatcher: ParseDispatcher): Map<string, ScannedFile | undefined> {
  let scanned = scannedByRun.get(dispatcher);
  if (scanned === undefined) {
    scanned = new Map();
    scannedByRun.set(dispatcher, scanned);
  }
  return scanned;
}

/**
 * Count `file` as scanned from its text this run, the first time any skills
 * lane of the run does so: a store miss (`skillText.storeMiss`) when the run
 * has a store to ask, else `skillText.noStore`.
 *
 * @param file - The file, resolved
 * @param run - The run
 */
function countScan(file: string, run: SkillTextRun): void {
  const scanned = scannedOf(run.dispatcher);
  if (scanned.has(file)) return;
  scanned.set(file, undefined);
  countWork(run.source.holdsStore ? 'skillText.storeMiss' : 'skillText.noStore', 1);
}

/**
 * The skill-text record of a file's text, for a lane that reads the text itself
 * (the skill validator's linked-file lane, the packaging lane on a file the
 * store does not serve): the core, counted once per file per run
 * ({@link countScan}). The same text a lane of the run already scanned is
 * answered from that scan.
 *
 * @param file - The file, absolute
 * @param text - Its text, frontmatter and all
 * @param run - The run: its dispatcher identifies it, its source says whether it has a store
 * @returns The record
 */
export function scannedSkillText(file: string, text: string, run: SkillTextRun): SkillTextFacts {
  const resolved = safePath.resolve(file);
  countScan(resolved, run);
  const scanned = scannedOf(run.dispatcher);
  const held = scanned.get(resolved);
  if (held?.text === text) return held.facts;
  const facts = skillTextFactsOf(text, SKILL_TEXT_DECLARATION);
  scanned.set(resolved, { text, facts });
  return facts;
}

/**
 * The skill-text record a linked file's compat and MCP scans run over. The
 * validator's linked-file lane has always scanned the file's raw UTF-8 text
 * (`readFileSync(path, 'utf-8')`: a UTF-8 BOM kept, UTF-16 and UTF-32 left
 * undecoded), not its decoded content. For a plain UTF-8 file the two are the
 * same text, so the document's record serves. For any other file the lane
 * scans the raw text, as it always did: the run's read of the file
 * ({@link rawUtf8Text}, one read per file per run, a member's from git in
 * a run that reads members from git) and a scan ({@link countScan}), counted.
 *
 * @param file - The linked file, absolute
 * @param document - Its document
 * @param run - The run
 * @returns The record to scan
 */
export async function linkedFileSkillText(file: string, document: SkillDocument, run: SkillTextRun): Promise<SkillTextFacts> {
  if (isPlainUtf8Decoding(document.decoding)) return document.skillText;
  return scannedSkillText(file, await rawUtf8Text(file, run.content), run);
}

/**
 * A file's raw UTF-8 text, what `readFileSync(path, 'utf-8')` gives (a UTF-8 BOM kept, UTF-16 and
 * UTF-32 left undecoded), from the run's one read of it: the text this package's raw scans (the
 * linked-file lane's, the implicit-reference scan's) have always run over. Not a decode of the
 * file's content: its content is the run's decoded read, and these scans deliberately do not use it.
 *
 * @param file - The file, absolute
 * @param content - The run's content reader
 * @returns The text
 */
export async function rawUtf8Text(file: string, content: RunContentCache): Promise<string> {
  const { keyed, bytes } = await content.readWithBytes(file, MARKDOWN_BY_CONTRACT);
  return bytes === null ? keyed.content : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf-8');
}

/**
 * A SKILL.md's document: the store's facts when the run's store serves it,
 * else its read (the run's content read, classified on `side` as
 * `parseFileCached` classifies it) and its parse on the run's dispatcher,
 * counted. A parse the worker refuses throws; nothing is counted then.
 *
 * @param skillPath - The SKILL.md
 * @param run - The run, or `undefined` for a caller with none (a run of its own)
 * @param side - Whose fault a refused read is
 * @returns The document
 */
export function readSkillDocument(skillPath: string, run: SkillTextRun | undefined, side: FsSide): Promise<SkillDocument> {
  return withSkillTextRun((lane) => readSkillDocumentOn(skillPath, lane, side), run);
}

/** {@link readSkillDocument}, on a run. */
async function readSkillDocumentOn(skillPath: string, run: SkillTextRun, side: FsSide): Promise<SkillDocument> {
  const stored = await run.source.storedDocument(skillPath, MARKDOWN_BY_CONTRACT);
  if (stored !== undefined) {
    const { frontmatter, frontmatterError, frontmatterNotAMapping, links, skillText } = stored.facts;
    return {
      frontmatter,
      frontmatterError,
      frontmatterNotAMapping,
      links,
      skillText,
      decoding: stored.decoding,
      text: async () => (await readContentForParse(skillPath, MARKDOWN_BY_CONTRACT, { dispatcher: run.dispatcher })).content,
    };
  }
  const keyed = await withFsFault({ side, origin: 'content', action: `read ${skillPath}`, path: skillPath }, () =>
    readContentForParse(skillPath, MARKDOWN_BY_CONTRACT, { dispatcher: run.dispatcher }),
  );
  const parsed = await run.dispatcher.parse(keyed);
  if (parsed.skillText === null) throw new Error(`The markdown parse of ${skillPath} carried no skill-text record`);
  countScan(safePath.resolve(skillPath), run);
  return {
    frontmatter: parsed.frontmatter,
    frontmatterError: parsed.frontmatterError,
    frontmatterNotAMapping: parsed.frontmatterNotAMapping === true,
    links: parsed.links,
    skillText: parsed.skillText,
    decoding: { encoding: keyed.decoding.encoding, encodingSource: keyed.decoding.encodingSource },
    text: () => Promise.resolve(keyed.content),
  };
}

/**
 * A bundled markdown file's skill-text record from the run's store, or
 * `undefined` when the store does not serve it: the caller then reads the
 * file's text and scans it ({@link scannedSkillText}), counted. Two calls, not
 * one taking a read callback, so a caller classifies its read's fault apart
 * from the store's (which refuses the run).
 *
 * @param file - The bundled file, absolute
 * @param run - The run
 * @returns The record, or `undefined`
 */
export async function storedSkillText(file: string, run: SkillTextRun): Promise<SkillTextFacts | undefined> {
  return (await run.source.storedDocument(file, 'markdown'))?.facts.skillText;
}

/**
 * A skill's name: its frontmatter `name`, else its first H1 (when the H1 has
 * text, trimmed), else the file's basename. The fallback is a KEY, not a
 * verdict: see `readSkillName` in the CLI's skill discovery.
 *
 * @param document - The SKILL.md's frontmatter and record
 * @param skillPath - The SKILL.md
 * @returns The name
 */
export function skillNameOf(
  document: Pick<SkillDocument, 'frontmatter' | 'skillText'>,
  skillPath: string,
): string {
  const name = document.frontmatter?.['name'];
  if (typeof name === 'string' && name.length > 0) return name;
  const { h1 } = document.skillText;
  if (h1) return h1.trim();
  return basename(skillPath, '.md');
}
