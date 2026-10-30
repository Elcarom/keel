// ============================================================================
// Pair legs (ADR-0032). A pair boat holds two coins against each other, one long and one short.
// The legs are traded as two ordinary positions, each with its own protective stop, and this
// rule keeps them together: after every bar, the live boat and the sea trial both apply it.
// ============================================================================

export type PairSide = "long" | "short";

/** One leg after a bar: its open position's side, and the side of an entry waiting for the open. */
export interface PairLegState {
  readonly open: PairSide | null;
  readonly pending: PairSide | null;
}

export interface PairReconciliation {
  /** Legs to close at this bar's close, by index. */
  readonly closeLegs: readonly (0 | 1)[];
  /** Whether to drop both legs' waiting entries. */
  readonly cancelPending: boolean;
}

/**
 * Never one leg without the other, and never both legs on the same side:
 * - a leg left open alone (its partner stopped out, hit its target or never filled) is closed
 * - two legs open on the same side are both closed
 * - entries go ahead only as a matched pair: both legs waiting, on opposite sides
 */
export function reconcilePairLegs(a: PairLegState, b: PairLegState): PairReconciliation {
  if (a.open && b.open) {
    return a.open === b.open
      ? { closeLegs: [0, 1], cancelPending: true }
      : { closeLegs: [], cancelPending: a.pending !== null || b.pending !== null };
  }
  if (a.open) return { closeLegs: [0], cancelPending: true };
  if (b.open) return { closeLegs: [1], cancelPending: true };
  const matched = a.pending !== null && b.pending !== null && a.pending !== b.pending;
  return { closeLegs: [], cancelPending: !matched && (a.pending !== null || b.pending !== null) };
}
