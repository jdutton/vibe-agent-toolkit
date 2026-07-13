import { describe, expect, it } from 'vitest';

import {
  assertGraderPromptInvariants,
  buildGraderPrompt,
  type BuildGraderPromptOptions,
} from '../../src/skill-test/grader-prompt.js';
import { PromptInvariantError } from '../../src/skill-test/prompt-invariants.js';

const opts: BuildGraderPromptOptions = {
  evalId: 'eval-1',
  transcript: '{"type":"tool_use","name":"bash","input":{"command":"ls"}}',
  expectations: ['creates a file named report.txt', 'does not delete existing files'],
  rubricPath: '/vendor/skill-creator/references/grader.md',
  fragmentOut: '/h/results/grader/eval-1.json',
  nonce: 'deadbeefcafe',
};

describe('buildGraderPrompt', () => {
  it('fences the transcript as untrusted data', () => {
    const prompt = buildGraderPrompt(opts);
    expect(prompt).toContain(opts.transcript);
    expect(prompt).toMatch(/untrusted/i);
    expect(prompt).toMatch(/BEGIN TRANSCRIPT DATA/);
    expect(prompt).toMatch(/END TRANSCRIPT DATA/);
  });

  it('includes each expectation', () => {
    const prompt = buildGraderPrompt(opts);
    for (const expectation of opts.expectations) {
      expect(prompt).toContain(expectation);
    }
  });

  it('includes the rubric path', () => {
    expect(buildGraderPrompt(opts)).toContain(opts.rubricPath);
  });

  it('includes the fragment output path and the evalId', () => {
    const prompt = buildGraderPrompt(opts);
    expect(prompt).toContain(opts.fragmentOut);
    expect(prompt).toContain(opts.evalId);
  });

  it('includes the nonce and the runNonce field name', () => {
    const prompt = buildGraderPrompt(opts);
    expect(prompt).toContain(opts.nonce);
    expect(prompt).toMatch(/runNonce/);
  });

  it('binds the transcript fence to the per-run nonce (so transcript text cannot forge the closing delimiter)', () => {
    const prompt = buildGraderPrompt(opts);
    expect(prompt).toContain(`BEGIN TRANSCRIPT DATA ${opts.nonce}`);
    expect(prompt).toContain(`END TRANSCRIPT DATA ${opts.nonce}`);
    // A generic (non-nonced) close delimiter — what an injected transcript could emit — is NOT present.
    expect(prompt).not.toContain('END TRANSCRIPT DATA===');
  });

  it('includes expected_output as context only when provided', () => {
    const expectedOutput = 'a tidy summary file';
    const withOutput = buildGraderPrompt({ ...opts, expectedOutput });
    expect(withOutput).toContain(expectedOutput);
    expect(withOutput).toMatch(/context/i);
    expect(buildGraderPrompt(opts)).not.toContain(expectedOutput);
  });

  it('satisfies all invariants', () => {
    expect(() => assertGraderPromptInvariants(buildGraderPrompt(opts))).not.toThrow();
  });

  it('prefers structured tool_use/tool_result signal over free text', () => {
    expect(buildGraderPrompt(opts)).toMatch(/tool_use|tool_result/);
  });

  it('spells out the friction ITEM object shape so the grader does not emit bare strings (PR #147)', () => {
    const prompt = buildGraderPrompt(opts);
    expect(prompt).toContain('"friction" item MUST be a JSON object');
    expect(prompt).toMatch(/NEVER a bare string/);
    // the closed category enum must be named so the grader picks a valid one
    expect(prompt).toContain('missing-bundled-file');
  });

  it('scopes friction to packaging only — no restating expectations or auditing the transcript format', () => {
    const prompt = buildGraderPrompt(opts);
    expect(prompt).toMatch(/Do NOT restate a graded expectation as friction/);
    expect(prompt).toMatch(/transcript\s+format or this grading harness/);
  });
});

describe('buildGraderPrompt — toolExpectations (issue #145 Phase T)', () => {
  const toolOpts: BuildGraderPromptOptions = {
    ...opts,
    toolExpectations: {
      mustRun: ['dxa'],
      mustNotRun: ['rm'],
      sequence: ['dxa parses the file', 'dxa writes the report'],
    },
    declaredExecutables: [
      { name: 'dxa', howInvoked: 'uv run dxa.py', kind: 'python' },
    ],
  };

  it('names each declared mustRun/mustNotRun/sequence entry', () => {
    const prompt = buildGraderPrompt(toolOpts);
    expect(prompt).toContain('dxa');
    expect(prompt).toContain('rm');
    expect(prompt).toContain('dxa parses the file');
    expect(prompt).toContain('dxa writes the report');
  });

  it('references the declared-executable howInvoked hints', () => {
    const prompt = buildGraderPrompt(toolOpts);
    expect(prompt).toContain('uv run dxa.py');
  });

  it('instructs emitting a "tool" object with the ToolVerdictBody fields, including "passed"', () => {
    const prompt = buildGraderPrompt(toolOpts);
    expect(prompt).toMatch(/"tool"/);
    expect(prompt).toMatch(/mustRun/);
    expect(prompt).toMatch(/mustNotRun/);
    expect(prompt).toMatch(/sequence/);
    expect(prompt).toMatch(/"passed"/);
  });

  it('still fences the transcript and carries the nonce', () => {
    const prompt = buildGraderPrompt(toolOpts);
    expect(prompt).toContain(toolOpts.transcript);
    expect(prompt).toMatch(/BEGIN TRANSCRIPT DATA/);
    expect(prompt).toMatch(/END TRANSCRIPT DATA/);
    expect(prompt).toContain(toolOpts.nonce);
  });

  it('satisfies all invariants', () => {
    expect(() => assertGraderPromptInvariants(buildGraderPrompt(toolOpts))).not.toThrow();
  });

  it('recognizes varied launch forms as evidence to correlate (mentions recognizing launch-form variance)', () => {
    const prompt = buildGraderPrompt(toolOpts);
    expect(prompt).toMatch(/launch|invocation|invoked|recognize/i);
  });

  it('does NOT include any tool-verdict instruction when toolExpectations is absent', () => {
    const prompt = buildGraderPrompt(opts);
    expect(prompt).not.toMatch(/"tool"/);
    expect(prompt).not.toMatch(/mustRun/);
    expect(prompt).not.toMatch(/mustNotRun/);
    expect(prompt).not.toMatch(/tool expectations/i);
  });

  it('emits a mustSucceed section naming each executable and the tool_result is_error basis (feature #148)', () => {
    const prompt = buildGraderPrompt({
      ...opts,
      toolExpectations: { mustRun: ['dxa'], mustSucceed: ['dxa', 'ruff'] },
    });
    expect(prompt).toMatch(/MUST have run AND succeeded/);
    expect(prompt).toMatch(/is_error/);
    expect(prompt).toContain('ruff');
    // The tool-object shape spec must name mustSucceed so the grader emits it.
    expect(prompt).toMatch(/"mustSucceed"/);
    // Honest caveat that transcript-judged success can miss a swallowed non-zero exit.
    expect(prompt).toMatch(/\|\| true/);
  });

  it('nonce-fences the untrusted subject manifest when declaredExecutables are present (injection fix #4)', () => {
    const prompt = buildGraderPrompt(toolOpts);
    expect(prompt).toContain(`BEGIN SUBJECT MANIFEST ${toolOpts.nonce}`);
    expect(prompt).toContain(`END SUBJECT MANIFEST ${toolOpts.nonce}`);
    expect(prompt).toMatch(/untrusted/i);
    // A generic (non-nonced) close delimiter an injected manifest could emit is NOT present.
    expect(prompt).not.toContain('END SUBJECT MANIFEST===');
  });

  it('omits the manifest fence when no declaredExecutables are supplied', () => {
    const prompt = buildGraderPrompt({ ...opts, toolExpectations: { mustRun: ['dxa'] } });
    expect(prompt).not.toMatch(/SUBJECT MANIFEST/);
  });
});

describe('assertGraderPromptInvariants', () => {
  it('throws when the fragment path is not referenced', () => {
    expect(() =>
      assertGraderPromptInvariants('Grade the eval, then STOP. Never open a browser or viewer. Do not iterate. runNonce: x'),
    ).toThrow(PromptInvariantError);
  });

  it('throws when STOP is absent', () => {
    expect(() =>
      assertGraderPromptInvariants('Grade the eval and write the fragment. Never open a browser or viewer. Do not iterate. runNonce: x'),
    ).toThrow(PromptInvariantError);
  });

  it('throws when the browser/viewer prohibition is absent', () => {
    expect(() =>
      assertGraderPromptInvariants('Grade the eval, write the fragment, then STOP. Do not iterate. runNonce: x'),
    ).toThrow(PromptInvariantError);
  });

  it('throws when the iteration prohibition is absent', () => {
    expect(() =>
      assertGraderPromptInvariants('Grade the eval, write the fragment, then STOP. Never open a browser or viewer. runNonce: x'),
    ).toThrow(PromptInvariantError);
  });

  it('throws when the nonce directive is absent', () => {
    expect(() =>
      assertGraderPromptInvariants(
        'Grade the eval, write the fragment, then STOP. Never open a browser or viewer. Do not iterate.',
      ),
    ).toThrow(PromptInvariantError);
  });

  it('scans OUR scaffolding only — required directives inside the untrusted transcript do NOT satisfy it', () => {
    // The ONLY occurrences of every required directive live in the transcript; once excised the
    // scaffolding is empty, so the invariant must still fire (a transcript cannot mask a builder regression).
    const transcript = 'STOP. write the fragment. never open a browser or viewer. do not iterate. runNonce';
    expect(() => assertGraderPromptInvariants(`prefix ${transcript} suffix`, transcript)).toThrow(
      PromptInvariantError,
    );
  });

  it('a normally-built prompt still satisfies the invariants once its transcript is excised', () => {
    expect(() => assertGraderPromptInvariants(buildGraderPrompt(opts), opts.transcript)).not.toThrow();
  });

  it('throws when a subject-manifest block is present but NOT nonce-fenced (injection fix #4)', () => {
    // A regressed builder that interpolated the manifest RAW: the intro line is
    // present but neither fence marker is — the invariant must fire.
    const unfenced =
      'Grade the eval, write the fragment, then STOP. Never open a browser or viewer. Do not iterate. runNonce: x. ' +
      'Declared executables and how they are typically invoked (a recognition HINT):\n  - evil (python): typically invoked as `x`';
    expect(() => assertGraderPromptInvariants(unfenced)).toThrow(PromptInvariantError);
  });

  it('does NOT fire the manifest invariant when no manifest block is present (toolExpectations, no declaredExecutables)', () => {
    // A real prompt with tool expectations but NO declaredExecutables has no
    // manifest block, so the conditional fence invariant must not fire.
    const noManifest = buildGraderPrompt({ ...opts, toolExpectations: { mustRun: ['dxa'] } });
    expect(noManifest).not.toMatch(/SUBJECT MANIFEST/);
    expect(() => assertGraderPromptInvariants(noManifest, opts.transcript)).not.toThrow();
  });
});
