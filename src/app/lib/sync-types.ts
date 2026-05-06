export type SyncMode = "stock" | "prices" | "costs";

export type ModeResult = {
  proposed: number;
  applied: number;
  skipped?: string;
  error?: string;
};

export type SyncResult = { [mode in SyncMode]?: ModeResult };

export const CANONICAL_ORDER: SyncMode[] = ["costs", "prices", "stock"];

export function canonicalizeModes(modes: SyncMode[]): SyncMode[] {
  return CANONICAL_ORDER.filter((mode) => modes.includes(mode));
}
