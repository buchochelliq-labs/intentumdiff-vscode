import { statusText } from "./mapper";
import { incompleteMessage } from "./reviewCompleteness";
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
  backgroundTooltip?: string,
): StatusPresentation {
  const owner = comparison ?? live;
  if (!owner) {
    return {
      text: background,
      tooltip: backgroundTooltip ? `IntentumDiff workspace review\n\n${backgroundTooltip}` : "IntentumDiff workspace review",
    };
  }
  const settled = !owner.error && !owner.pending && owner.diff !== undefined;
  const text = owner.error ? "IntentumDiff: review error"
    : !settled ? (comparison ? "IntentumDiff: review pending" : "IntentumDiff: diffing")
    : statusText(owner.diff!);
  // Core issue 252: an incomplete review carries core's message verbatim in the tooltip.
  const incomplete = settled ? incompleteMessage(owner.diff) : undefined;
  const tooltip = `${owner.relativePath}\nComparison: ${owner.baseline}`;
  return { text, tooltip: incomplete !== undefined ? `${tooltip}\n\n${incomplete}` : tooltip };
}
