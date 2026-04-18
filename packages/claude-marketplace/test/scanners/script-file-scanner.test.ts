import { describe, expect, it } from 'vitest';

import { classifyScriptFile, PYTHON_STDLIB_MODULES, scanPythonImports } from '../../src/scanners/script-file-scanner.js';

const SCRIPT_FILE_NODE = 'SCRIPT_FILE_NODE';
const CALC_SCRIPT_PATH = 'scripts/calc.py';

describe('classifyScriptFile', () => {
  it('classifies .py file as SCRIPT_FILE_PYTHON evidence', () => {
    const result = classifyScriptFile(CALC_SCRIPT_PATH);
    expect(result?.patternId).toBe('SCRIPT_FILE_PYTHON');
    expect(result?.location.file).toBe(CALC_SCRIPT_PATH);
  });

  it('classifies .sh file as SCRIPT_FILE_SHELL evidence', () => {
    const result = classifyScriptFile('scripts/setup.sh');
    expect(result?.patternId).toBe('SCRIPT_FILE_SHELL');
  });

  it('classifies .bash file as SCRIPT_FILE_SHELL evidence', () => {
    const result = classifyScriptFile('scripts/setup.bash');
    expect(result?.patternId).toBe('SCRIPT_FILE_SHELL');
  });

  it('classifies .mjs file as SCRIPT_FILE_NODE evidence', () => {
    const result = classifyScriptFile('scripts/process.mjs');
    expect(result?.patternId).toBe(SCRIPT_FILE_NODE);
  });

  it('classifies .js and .cjs files as SCRIPT_FILE_NODE', () => {
    expect(classifyScriptFile('scripts/a.js')?.patternId).toBe(SCRIPT_FILE_NODE);
    expect(classifyScriptFile('scripts/a.cjs')?.patternId).toBe(SCRIPT_FILE_NODE);
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

    const result = scanPythonImports(content, CALC_SCRIPT_PATH);
    expect(result).toEqual([]);
  });

  it('detects third-party imports as PYTHON_IMPORT_THIRD_PARTY evidence', () => {
    const content = [
      'import pandas as pd',
      'from sklearn.cluster import KMeans',
      'import numpy as np',
    ].join('\n');

    const result = scanPythonImports(content, 'scripts/analyze.py');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.every(e => e.patternId === 'PYTHON_IMPORT_THIRD_PARTY')).toBe(true);
    expect(result.some(e => e.matchText.includes('pandas'))).toBe(true);
  });

  it('detects pydantic as third-party', () => {
    const content = 'from pydantic import BaseModel';
    const result = scanPythonImports(content, 'scripts/model.py');
    expect(result.some(e => e.matchText.includes('pydantic'))).toBe(true);
  });

  it('handles mixed stdlib and third-party imports', () => {
    const content = [
      'import sys',
      'import json',
      'import pandas as pd',
      'from pathlib import Path',
    ].join('\n');

    const result = scanPythonImports(content, 'scripts/mixed.py');
    expect(result.length).toBe(1);
    expect(result[0]?.matchText).toContain('pandas');
  });

  it('handles from-imports correctly', () => {
    const content = 'from collections import defaultdict';
    const result = scanPythonImports(content, 'scripts/stdlib.py');
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
