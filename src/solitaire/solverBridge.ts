// Pure TS side of the solver FFI contract (no native imports — jest-testable).
// Single source of truth for the JSON shapes:
// docs/product/hints/hints-and-unwinnable-warning.md, section "FFI contract";
// the Rust mirror is rust/soli-solver-ffi/src/protocol.rs (serde camelCase).
// Card code = `<suit letter c|d|h|s><rank 1..13>`, e.g. "c1" = A♣, "s13" = K♠.
// All suit-order remapping to lonelybot's conventions happens inside Rust.

import type { Card, GameSnapshot, Suit } from './klondike'

export type SolverSuitLetter = 'c' | 'd' | 'h' | 's'

const SUIT_LETTERS: Record<Suit, SolverSuitLetter> = {
  clubs: 'c',
  diamonds: 'd',
  hearts: 'h',
  spades: 's',
}

export const SOLVER_SUIT_FROM_LETTER: Record<SolverSuitLetter, Suit> = {
  c: 'clubs',
  d: 'diamonds',
  h: 'hearts',
  s: 'spades',
}

export const cardToSolverCode = (card: Pick<Card, 'suit' | 'rank'>): string =>
  `${SUIT_LETTERS[card.suit]}${card.rank}`

// Reverse of cardToSolverCode; used to render/announce hint cards. Inputs come
// from the Rust side, which only ever emits codes it parsed itself.
export const parseSolverCardCode = (code: string): Pick<Card, 'suit' | 'rank'> => ({
  suit: SOLVER_SUIT_FROM_LETTER[code[0] as SolverSuitLetter],
  rank: Number(code.slice(1)) as Card['rank'],
})

export type SolverRequest = {
  drawCount: number
  budgetMs: number
  foundations: Record<SolverSuitLetter, number>
  tableau: Array<{ hidden: string[]; visible: string[] }>
  // App array order passed through unchanged. Contract (verified in
  // klondike.ts): stock's LAST element is drawn next (drawFromStock /
  // getNextStockDrawCards slice from the end); waste's LAST element is the
  // top/playable card. Rust reverses the stock into lonelybot's deck layout.
  stock: string[]
  waste: string[]
}

export type SolverStatus = 'solved' | 'unsolvable' | 'unknown' | 'invalid' | 'error'

export type SolverHintFrom =
  | { type: 'tableau'; index: number }
  | { type: 'waste' }
  | { type: 'foundation'; suit: SolverSuitLetter }

export type SolverHintTo =
  | { type: 'tableau'; index: number }
  // Target foundation is implied by the card's suit.
  | { type: 'foundation' }

export type SolverHint =
  // Tap the stock once (covers recycling too; one hint = one tap even if
  // several draws precede the winning play).
  | { kind: 'draw' }
  | { kind: 'move'; card: string; from: SolverHintFrom; to: SolverHintTo }

export type SolverMoveHint = Extract<SolverHint, { kind: 'move' }>

export type SolverResponse = {
  status: SolverStatus
  message?: string
  solveMs?: number
  visited?: number
  // Primitive (lonelybot) move count of the found winning line.
  winMovesRemaining?: number
  // Present only when status is 'solved' AND the position is not already won.
  hint?: SolverHint
}

// Serializes the committed board for the solver. Only GameSnapshot board
// fields are read — live-only state (selection, history, timer) never
// influences solvability.
export const buildSolverRequest = (
  snapshot: Pick<
    GameSnapshot,
    'drawCount' | 'foundations' | 'tableau' | 'stock' | 'waste'
  >,
  budgetMs: number
): SolverRequest => ({
  drawCount: snapshot.drawCount,
  budgetMs,
  foundations: {
    c: snapshot.foundations.clubs.length,
    d: snapshot.foundations.diamonds.length,
    h: snapshot.foundations.hearts.length,
    s: snapshot.foundations.spades.length,
  },
  tableau: snapshot.tableau.map((column) => ({
    // Column order is bottom→top; face-down cards are always a prefix of the
    // column, so filtering preserves the contract's hidden/visible split.
    hidden: column.filter((card) => !card.faceUp).map(cardToSolverCode),
    visible: column.filter((card) => card.faceUp).map(cardToSolverCode),
  })),
  stock: snapshot.stock.map(cardToSolverCode),
  waste: snapshot.waste.map(cardToSolverCode),
})

const SOLVER_STATUSES: readonly SolverStatus[] = [
  'solved',
  'unsolvable',
  'unknown',
  'invalid',
  'error',
]

// Defensive parse of the native response. The Rust side owns deep validation;
// this only guards the JS boundary (malformed JSON / unexpected status) and
// degrades to a synthetic 'error' response instead of throwing into UI code.
export const parseSolverResponse = (json: string): SolverResponse => {
  try {
    const parsed = JSON.parse(json) as SolverResponse
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !SOLVER_STATUSES.includes(parsed.status)
    ) {
      return { status: 'error', message: `unexpected solver response: ${json}` }
    }
    return parsed
  } catch {
    return { status: 'error', message: `unparsable solver response: ${json}` }
  }
}
