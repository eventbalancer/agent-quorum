export type KeyEvent =
  | { readonly kind: 'up' }
  | { readonly kind: 'down' }
  | { readonly kind: 'left' }
  | { readonly kind: 'right' }
  | { readonly kind: 'enter' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'tab' }
  | { readonly kind: 'space' }
  | { readonly kind: 'ctrl-c' }
  | { readonly kind: 'char'; readonly value: string }
  | { readonly kind: 'none' };

export interface ReadlineKey {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly sequence?: string;
}

function isPrintable(str: string): boolean {
  return str.length === 1 && str >= ' ' && str <= '~';
}

// Maps a `node:readline` keypress `(str, key)` pair to a semantic KeyEvent. Pure:
// the editing-vs-shortcut (and thus quit) decision belongs to the reducer, which
// knows the focused field; the decoder only classifies the physical key.
export function decodeKey(str: string | undefined, key: ReadlineKey | undefined): KeyEvent {
  const meta = key ?? {};
  if (meta.ctrl === true && meta.name === 'c') {
    return { kind: 'ctrl-c' };
  }
  switch (meta.name) {
    case 'up':
      return { kind: 'up' };
    case 'down':
      return { kind: 'down' };
    case 'left':
      return { kind: 'left' };
    case 'right':
      return { kind: 'right' };
    case 'return':
    case 'enter':
      return { kind: 'enter' };
    case 'escape':
      return { kind: 'escape' };
    case 'backspace':
      return { kind: 'backspace' };
    case 'tab':
      return { kind: 'tab' };
    case 'space':
      return { kind: 'space' };
    default:
      break;
  }
  if (str === ' ') {
    return { kind: 'space' };
  }
  if (str !== undefined && meta.ctrl !== true && isPrintable(str)) {
    return { kind: 'char', value: str };
  }
  return { kind: 'none' };
}
