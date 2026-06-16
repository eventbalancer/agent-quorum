import { describe, expect, it } from 'vitest';
import { decodeKey } from '../../src/cli/shell/keys.js';

describe('decodeKey', () => {
  it('maps arrows, enter, escape, tab, space, and backspace', () => {
    expect(decodeKey(undefined, { name: 'up' })).toEqual({ kind: 'up' });
    expect(decodeKey(undefined, { name: 'down' })).toEqual({ kind: 'down' });
    expect(decodeKey(undefined, { name: 'left' })).toEqual({ kind: 'left' });
    expect(decodeKey(undefined, { name: 'right' })).toEqual({ kind: 'right' });
    expect(decodeKey('\r', { name: 'return' })).toEqual({ kind: 'enter' });
    expect(decodeKey(undefined, { name: 'escape' })).toEqual({ kind: 'escape' });
    expect(decodeKey('\t', { name: 'tab' })).toEqual({ kind: 'tab' });
    expect(decodeKey(' ', { name: 'space' })).toEqual({ kind: 'space' });
    expect(decodeKey(undefined, { name: 'backspace' })).toEqual({ kind: 'backspace' });
  });

  it('maps ctrl-c regardless of context', () => {
    expect(decodeKey('', { name: 'c', ctrl: true })).toEqual({ kind: 'ctrl-c' });
  });

  it('maps printable characters to char events', () => {
    expect(decodeKey('q', { name: 'q' })).toEqual({ kind: 'char', value: 'q' });
    expect(decodeKey('j', { name: 'j' })).toEqual({ kind: 'char', value: 'j' });
    expect(decodeKey('?', {})).toEqual({ kind: 'char', value: '?' });
  });

  it('treats a raw space as space even without a key name', () => {
    expect(decodeKey(' ', undefined)).toEqual({ kind: 'space' });
  });

  it('returns none for unhandled control sequences and function keys', () => {
    expect(decodeKey('', { name: 'a', ctrl: true })).toEqual({ kind: 'none' });
    expect(decodeKey(undefined, { name: 'f5' })).toEqual({ kind: 'none' });
  });
});
