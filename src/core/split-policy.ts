export type SplitMode = 'always' | 'never' | 'auto';

export interface SplitPolicy {
  readonly mode: SplitMode;
  readonly minPhases: number;
}
