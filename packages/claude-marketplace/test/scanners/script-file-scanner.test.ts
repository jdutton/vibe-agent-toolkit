import { describe, expect, it } from 'vitest';

import { classifyScriptFile, PYTHON_STDLIB_MODULES, scanPythonImports } from '../../src/scanners/script-file-scanner.js';

describe('classifyScriptFile', () => {
  it('classifies .py file as needs-review for desktop', () => {
    const result = classifyScriptFile('scripts/calc.py');
    expect(result).toMatchObject({
      source: 'script',
      signal: 'python-script',
      impact: {
        'claude-desktop': 'needs-review',
        cowork: 'ok',
        'claude-code': 'ok',
      },
    });
  });

  it('classifies .sh file as needs-review for desktop', () => {
    const result = classifyScriptFile('scripts/setup.sh');
    expect(result).toMatchObject({
      signal: 'shell-script',
      impact: {
        'claude-desktop': 'needs-review',
        cowork: 'ok',
        'claude-code': 'ok',
      },
    });
  });

  it('classifies .mjs file as compatible everywhere', () => {
    const result = classifyScriptFile('scripts/process.mjs');
    expect(result).toMatchObject({
      signal: 'node-script',
      impact: {
        'claude-desktop': 'ok',
        cowork: 'ok',
        'claude-code': 'ok',
      },
    });
  });

  it('returns undefined for non-script files', () => {
    expect(classifyScriptFile('README.md')).toBeUndefined();
    expect(classifyScriptFile('plugin.json')).toBeUndefined();
    expect(classifyScriptFile('SKILL.md')).toBeUndefined();
  });
});

describe('scanPythonImports', () => {
  it('returns empty for stdlib-only imports', () => {
    const content = [
      'import sys',
      'import json',
      'from pathlib import Path',
      'import os',
    ].join('\n');

    const result = scanPythonImports(content, 'scripts/calc.py');
    expect(result).toEqual([]);
  });

  it('detects third-party imports', () => {
    const content = [
      'import pandas as pd',
      'from sklearn.cluster import KMeans',
      'import numpy as np',
    ].join('\n');

    const result = scanPythonImports(content, 'scripts/analyze.py');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some(e => e.signal.includes('pandas'))).toBe(true);
    expect(result[0]?.source).toBe('script-import');
  });

  it('detects pydantic as third-party', () => {
    const content = 'from pydantic import BaseModel';
    const result = scanPythonImports(content, 'scripts/model.py');
    expect(result.some(e => e.signal.includes('pydantic'))).toBe(true);
  });

  it('handles mixed stdlib and third-party imports', () => {
    const content = [
      'import sys',
      'import json',
      'import pandas as pd',
      'from pathlib import Path',
    ].join('\n');

    const result = scanPythonImports(content, 'scripts/mixed.py');
    // Only reports third-party imports
    expect(result.length).toBe(1);
    expect(result[0]?.signal).toContain('pandas');
  });

  it('handles from-imports correctly', () => {
    const content = 'from collections import defaultdict';
    const result = scanPythonImports(content, 'scripts/stdlib.py');
    // collections is stdlib, no evidence
    expect(result).toEqual([]);
  });
});

describe('PYTHON_STDLIB_MODULES', () => {
  it('includes common stdlib modules', () => {
    for (const mod of ['os', 'sys', 'json', 'pathlib', 're', 'math', 'collections',
      'datetime', 'typing', 'dataclasses', 'argparse', 'logging', 'csv',
      'hashlib', 'base64', 'copy', 'functools', 'itertools', 'subprocess',
      'shutil', 'glob', 'tempfile', 'io', 'string', 'textwrap', 'enum',
      'abc', 'contextlib', 'unittest', 'sqlite3', 'configparser']) {
      expect(PYTHON_STDLIB_MODULES.has(mod)).toBe(true);
    }
  });

  it('does not include common third-party packages', () => {
    for (const mod of ['pandas', 'numpy', 'sklearn', 'scikit-learn', 'pydantic',
      'requests', 'flask', 'django', 'matplotlib', 'seaborn', 'scipy']) {
      expect(PYTHON_STDLIB_MODULES.has(mod)).toBe(false);
    }
  });
});
