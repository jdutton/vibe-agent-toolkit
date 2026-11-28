import { afterEach, describe, expect, it } from 'vitest';

import { openIoWindow } from '../src/projection/io-window.js';

const WINDOW_KEY = Symbol.for('vat.lab.io.window');

afterEach(() => {
  Reflect.deleteProperty(globalThis, WINDOW_KEY);
});

describe('openIoWindow', () => {
  it('is inert when no window function is installed: the same shared close every time', () => {
    const first = openIoWindow();
    const second = openIoWindow();
    expect(first).toBe(second);
    expect(() => first()).not.toThrow();
  });

  it('reads no environment variable to decide', () => {
    const before = process.env['VAT_LAB_IO_WINDOW'];
    process.env['VAT_LAB_IO_WINDOW'] = '1';
    try {
      expect(openIoWindow()).toBe(openIoWindow());
    } finally {
      if (before === undefined) delete process.env['VAT_LAB_IO_WINDOW'];
      else process.env['VAT_LAB_IO_WINDOW'] = before;
    }
  });

  it('opens the installed window and returns its close', () => {
    const events: string[] = [];
    Reflect.set(globalThis, WINDOW_KEY, () => {
      events.push('open');
      return () => events.push('close');
    });
    const close = openIoWindow();
    expect(events).toEqual(['open']);
    close();
    expect(events).toEqual(['open', 'close']);
  });

  it('ignores a value under the key that is not a function', () => {
    Reflect.set(globalThis, WINDOW_KEY, 'not a function');
    expect(() => openIoWindow()()).not.toThrow();
  });

  it('survives an installed function that returns no close', () => {
    Reflect.set(globalThis, WINDOW_KEY, () => undefined);
    expect(() => openIoWindow()()).not.toThrow();
  });
});
