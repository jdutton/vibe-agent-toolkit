import { describe, expect, it } from 'vitest';

import { SKILL_TEXT_DECLARATION } from '../../src/skill-text/declaration.js';
import { frontmatterFencesOf } from '../../src/skill-text/frontmatter-fences.js';

const BOM = String.fromCodePoint(0xfe_ff);

function fences(text: string): ReturnType<typeof frontmatterFencesOf> {
  return frontmatterFencesOf(text, SKILL_TEXT_DECLARATION);
}

describe('frontmatterFencesOf', () => {
  it('splits on LF, CRLF and a lone CR, and finds the closing fence', () => {
    expect(fences('---\r\nname: x\r---  \nbody\r\nmore')).toEqual({
      lines: ['---', 'name: x', '---  ', 'body', 'more'],
      opened: true,
      closing: 2,
    });
  });

  it('drops one leading BOM, and only one', () => {
    expect(fences(`${BOM}---\n---\nb`)).toEqual({ lines: ['---', '---', 'b'], opened: true, closing: 1 });
    expect(fences(`${BOM}${BOM}---\n---`).opened).toBe(false);
  });

  it('has no opening fence unless the first line is exactly three dashes then spaces or tabs', () => {
    for (const first of ['----', '---x', ' ---', 'name: x', '']) {
      expect(fences(`${first}\n---\n`)).toMatchObject({ opened: false, closing: -1 });
    }
    expect(fences('---\t \nx\n---').opened).toBe(true);
  });

  it('reports a missing closing fence as -1', () => {
    expect(fences('---\nname: x\n----\n')).toEqual({ lines: ['---', 'name: x', '----', ''], opened: true, closing: -1 });
  });

  it('closes at the first fence after the opening one', () => {
    expect(fences('---\n---\n---\n').closing).toBe(1);
  });
});
