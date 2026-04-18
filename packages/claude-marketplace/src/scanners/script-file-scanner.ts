import { extname } from 'node:path';

import type { EvidenceRecord } from '@vibe-agent-toolkit/agent-skills';

import { buildEvidence } from './evidence-helpers.js';

/** Python 3.10+ standard library modules */
export const PYTHON_STDLIB_MODULES: ReadonlySet<string> = new Set([
  '_thread',
  'abc',
  'argparse',
  'ast',
  'asyncio',
  'base64',
  'bisect',
  'builtins',
  'calendar',
  'cmath',
  'cmd',
  'codecs',
  'collections',
  'colorsys',
  'compileall',
  'concurrent',
  'configparser',
  'contextlib',
  'contextvars',
  'copy',
  'copyreg',
  'cProfile',
  'csv',
  'ctypes',
  'curses',
  'dataclasses',
  'datetime',
  'decimal',
  'difflib',
  'dis',
  'email',
  'enum',
  'errno',
  'faulthandler',
  'filecmp',
  'fileinput',
  'fnmatch',
  'fractions',
  'ftplib',
  'functools',
  'gc',
  'getopt',
  'getpass',
  'gettext',
  'glob',
  'graphlib',
  'gzip',
  'hashlib',
  'heapq',
  'hmac',
  'html',
  'http',
  'idlelib',
  'imaplib',
  'importlib',
  'inspect',
  'io',
  'ipaddress',
  'itertools',
  'json',
  'keyword',
  'linecache',
  'locale',
  'logging',
  'lzma',
  'mailbox',
  'math',
  'mimetypes',
  'modulefinder',
  'multiprocessing',
  'netrc',
  'numbers',
  'operator',
  'os',
  'pathlib',
  'pdb',
  'pickle',
  'pickletools',
  'platform',
  'plistlib',
  'poplib',
  'posixpath',
  'pprint',
  'profile',
  'pstats',
  'py_compile',
  'pyclbr',
  'pydoc',
  'queue',
  'quopri',
  'random',
  're',
  'readline',
  'reprlib',
  'runpy',
  'sched',
  'secrets',
  'select',
  'selectors',
  'shelve',
  'shlex',
  'shutil',
  'signal',
  'site',
  'smtplib',
  'socket',
  'socketserver',
  'sqlite3',
  'ssl',
  'stat',
  'statistics',
  'string',
  'stringprep',
  'struct',
  'subprocess',
  'sys',
  'sysconfig',
  'syslog',
  'tabnanny',
  'tarfile',
  'tempfile',
  'test',
  'textwrap',
  'threading',
  'time',
  'timeit',
  'tkinter',
  'token',
  'tokenize',
  'tomllib',
  'trace',
  'traceback',
  'tracemalloc',
  'turtle',
  'types',
  'typing',
  'unicodedata',
  'unittest',
  'urllib',
  'uuid',
  'venv',
  'warnings',
  'wave',
  'weakref',
  'webbrowser',
  'xml',
  'xmlrpc',
  'zipapp',
  'zipfile',
  'zipimport',
  'zlib',
]);

/** Map script extensions to the pattern ID that records their presence. */
const SCRIPT_EXTENSION_PATTERNS: Record<string, string> = {
  '.py': 'SCRIPT_FILE_PYTHON',
  '.sh': 'SCRIPT_FILE_SHELL',
  '.bash': 'SCRIPT_FILE_SHELL',
  '.mjs': 'SCRIPT_FILE_NODE',
  '.js': 'SCRIPT_FILE_NODE',
  '.cjs': 'SCRIPT_FILE_NODE',
};

/** Regex for `import X` and `import X as Y` */
const IMPORT_RE = /^import\s+(\w+)/;

/** Regex for `from X import Y` and `from X.sub import Y` */
const FROM_IMPORT_RE = /^from\s+(\w+)/;

/**
 * Classify a script file by its extension. Returns a single SCRIPT_FILE_*
 * evidence record when the extension matches a known script type.
 */
export function classifyScriptFile(relativePath: string): EvidenceRecord | undefined {
  const ext = extname(relativePath).toLowerCase();
  const patternId = SCRIPT_EXTENSION_PATTERNS[ext];
  if (patternId === undefined) {
    return undefined;
  }
  return buildEvidence(patternId, relativePath, `script file: ${relativePath}`);
}

/**
 * Parse Python source content for import statements and return evidence
 * for any third-party (non-stdlib) imports found, one record per distinct
 * module.
 */
export function scanPythonImports(content: string, filePath: string): EvidenceRecord[] {
  const thirdPartyModules = new Set<string>();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    let moduleName: string | undefined;

    const importMatch = IMPORT_RE.exec(trimmed);
    if (importMatch) {
      moduleName = importMatch[1];
    }

    const fromMatch = FROM_IMPORT_RE.exec(trimmed);
    if (fromMatch) {
      moduleName = fromMatch[1];
    }

    if (moduleName && !PYTHON_STDLIB_MODULES.has(moduleName)) {
      thirdPartyModules.add(moduleName);
    }
  }

  const evidence: EvidenceRecord[] = [];

  for (const moduleName of thirdPartyModules) {
    evidence.push(
      buildEvidence(
        'PYTHON_IMPORT_THIRD_PARTY',
        filePath,
        `third-party import: ${moduleName}`,
      ),
    );
  }

  return evidence;
}
