import { extname } from 'node:path';

import type { CompatibilityEvidence, ImpactLevel, Target } from '../types.js';
import { IMPACT_ALL_OK, IMPACT_NEEDS_REVIEW_DESKTOP } from '../types.js';

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

const SIGNAL_NODE_SCRIPT = 'node-script';
const SIGNAL_SHELL_SCRIPT = 'shell-script';

/** Script extension classification rules */
const SCRIPT_RULES: Record<string, { signal: string; impact: Record<Target, ImpactLevel> }> = {
  '.py': {
    signal: 'python-script',
    impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP },
  },
  '.sh': {
    signal: SIGNAL_SHELL_SCRIPT,
    impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP },
  },
  '.bash': {
    signal: SIGNAL_SHELL_SCRIPT,
    impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP },
  },
  '.mjs': {
    signal: SIGNAL_NODE_SCRIPT,
    impact: { ...IMPACT_ALL_OK },
  },
  '.js': {
    signal: SIGNAL_NODE_SCRIPT,
    impact: { ...IMPACT_ALL_OK },
  },
  '.cjs': {
    signal: SIGNAL_NODE_SCRIPT,
    impact: { ...IMPACT_ALL_OK },
  },
};

/** Regex for `import X` and `import X as Y` */
const IMPORT_RE = /^import\s+(\w+)/;

/** Regex for `from X import Y` and `from X.sub import Y` */
const FROM_IMPORT_RE = /^from\s+(\w+)/;

/**
 * Classify a script file by its extension and return compatibility evidence.
 * Returns undefined for non-script files.
 */
export function classifyScriptFile(relativePath: string): CompatibilityEvidence | undefined {
  const ext = extname(relativePath).toLowerCase();
  const rule = SCRIPT_RULES[ext];

  if (!rule) {
    return undefined;
  }

  return {
    source: 'script',
    file: relativePath,
    signal: rule.signal,
    detail: `Script file detected: ${relativePath}`,
    impact: { ...rule.impact },
  };
}

/**
 * Parse Python source content for import statements and return evidence
 * for any third-party (non-stdlib) imports found.
 */
export function scanPythonImports(content: string, filePath: string): CompatibilityEvidence[] {
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

  const evidence: CompatibilityEvidence[] = [];

  for (const moduleName of thirdPartyModules) {
    evidence.push({
      source: 'script-import',
      file: filePath,
      signal: `third-party-import:${moduleName}`,
      detail: `Third-party Python import "${moduleName}" requires pip install`,
      impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP },
    });
  }

  return evidence;
}
