import { statusText } from "./mapper";
import type { SemanticDiff } from "./types";

export interface StatusContext {
  relativePath: string;
  baseline: string;
  diff?: SemanticDiff;
  pending?: boolean;
  error?: boolean;
}
export interface StatusPresentation { text: string; tooltip: string; }

// The visible comparison owns its status, even when background/live work finishes.
export function statusForOwner(
  background: string,
  comparison?: StatusContext,
  live?: StatusContext,
): StatusPresentation {
  const owner = comparison ?? live;
  if (!owner) return { text: background, tooltip: "IntentumDiff workspace review" };
  const text = owner.error ? "IntentumDiff: review error"
    : owner.pending || !owner.diff ? (comparison ? "IntentumDiff: review pending" : "IntentumDiff: diffing")
    : statusText(owner.diff);
  return { text, tooltip: `${owner.relativePath}\nComparison: ${owner.baseline}` };
}
