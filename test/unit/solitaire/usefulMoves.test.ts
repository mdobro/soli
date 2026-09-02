import type { Foundations } from '../../../src/solitaire/klondike'
import {
  collectReachableWasteTops,
  findFirstUsefulMove,
  hasUsefulMove,
  type UsefulMoveBoard,
} from '../../../src/solitaire/usefulMoves'
import { card, foundationPileThrough, tableauWith } from './helpers'

const emptyFoundations = (): Foundations => ({
  hearts: [],
  diamonds: [],
  clubs: [],
  spades: [],
})

const board = (overrides: Partial<UsefulMoveBoard> = {}): UsefulMoveBoard => ({
  tableau: tableauWith(),
  foundations: emptyFoundations(),
  stock: [],
  waste: [],
  drawCount: 1,
  ...overrides,
})

// Inert single-card columns: all black, non-adjacent ranks, no aces — they can
// never stack on each other, reach a foundation, or receive a red fixture card
// unless a test wires that up on purpose. Used to fill the tableau so empty
// columns don't accidentally make waste kings useful.
const fillers = () => [
  [card('spades', 2)],
  [card('clubs', 2)],
  [card('spades', 4)],
  [card('clubs', 4)],
  [card('spades', 6)],
]

describe('findFirstUsefulMove', () => {
  it('finds a tableau top foundation play first (priority over waste plays)', () => {
    const result = findFirstUsefulMove(
      board({
        tableau: [[card('spades', 1)], [card('clubs', 9)], ...fillers()],
        // The waste ace would also play — the tableau one must win (priority).
        waste: [card('hearts', 1)],
      })
    )
    expect(result).toEqual({
      kind: 'move',
      card: 's1',
      from: { type: 'tableau', index: 0 },
      to: { type: 'foundation' },
    })
  })

  it('finds a waste-top foundation play', () => {
    const result = findFirstUsefulMove(
      board({
        tableau: [[card('clubs', 9)], [card('spades', 9)], ...fillers()],
        foundations: {
          ...emptyFoundations(),
          diamonds: foundationPileThrough('diamonds', 1),
        },
        waste: [card('spades', 10), card('diamonds', 2)],
      })
    )
    expect(result).toEqual({
      kind: 'move',
      card: 'd2',
      from: { type: 'waste' },
      to: { type: 'foundation' },
    })
  })

  it('finds a waste-top tableau play', () => {
    const result = findFirstUsefulMove(
      board({
        tableau: [[card('clubs', 9)], [card('spades', 7)], ...fillers()],
        waste: [card('hearts', 6)],
      })
    )
    expect(result).toEqual({
      kind: 'move',
      card: 'h6',
      from: { type: 'waste' },
      to: { type: 'tableau', index: 1 },
    })
  })

  it('finds a waste king to an empty column', () => {
    const result = findFirstUsefulMove(
      board({
        tableau: [[card('clubs', 9)], [], ...fillers()],
        waste: [card('diamonds', 13)],
      })
    )
    expect(result).toEqual({
      kind: 'move',
      card: 'd13',
      from: { type: 'waste' },
      to: { type: 'tableau', index: 1 },
    })
  })

  it('finds a full-run move that reveals a face-down card', () => {
    const result = findFirstUsefulMove(
      board({
        tableau: [
          [card('diamonds', 3, false), card('hearts', 8), card('spades', 7)],
          [card('spades', 9)],
          ...fillers(),
        ],
      })
    )
    expect(result).toEqual({
      kind: 'move',
      card: 'h8',
      from: { type: 'tableau', index: 0 },
      to: { type: 'tableau', index: 1 },
    })
  })

  it('finds a full-run move that frees a column (non-king base, nothing beneath)', () => {
    const result = findFirstUsefulMove(
      board({
        tableau: [
          [card('hearts', 8), card('spades', 7)],
          [card('spades', 9)],
          ...fillers(),
        ],
      })
    )
    expect(result).toEqual({
      kind: 'move',
      card: 'h8',
      from: { type: 'tableau', index: 0 },
      to: { type: 'tableau', index: 1 },
    })
  })

  it('excludes king-run shuffles between empty columns (classic no-op)', () => {
    // K♦+Q♠ with nothing beneath could legally move to the empty column, but
    // that achieves nothing — Aisleriot's exclusion, kept on purpose.
    const result = findFirstUsefulMove(
      board({
        tableau: [[card('diamonds', 13), card('spades', 12)], [], ...fillers()],
      })
    )
    expect(result).toBeNull()
  })

  it('still counts king-run moves to an empty column when they reveal', () => {
    const result = findFirstUsefulMove(
      board({
        tableau: [
          [card('hearts', 4, false), card('diamonds', 13), card('spades', 12)],
          [],
          ...fillers(),
        ],
      })
    )
    expect(result).toEqual({
      kind: 'move',
      card: 'd13',
      from: { type: 'tableau', index: 0 },
      to: { type: 'tableau', index: 1 },
    })
  })

  it('excludes foundation-to-tableau digs (Microsoft false-positive class)', () => {
    // 5♦ could dig down onto the black 6 — classic apps never count that, and
    // neither do we (the solver confirmation covers the cases where the dig
    // would actually matter).
    const result = findFirstUsefulMove(
      board({
        tableau: [[card('clubs', 6)], [card('spades', 9)], ...fillers()],
        foundations: {
          ...emptyFoundations(),
          diamonds: foundationPileThrough('diamonds', 5),
        },
      })
    )
    expect(result).toBeNull()
  })

  it('counts a partial-run split only when the exposed card plays to a foundation', () => {
    const tableau = () => [
      // 9♠ buried under 8♥+7♠; the split exposes it.
      [card('spades', 9), card('hearts', 8), card('spades', 7)],
      [card('clubs', 9)],
      ...fillers(),
    ]

    // Spades foundation through 8 → exposing 9♠ enables an immediate play.
    expect(
      findFirstUsefulMove(
        board({
          tableau: tableau(),
          foundations: {
            ...emptyFoundations(),
            spades: foundationPileThrough('spades', 8),
          },
        })
      )
    ).toEqual({
      kind: 'move',
      card: 'h8',
      from: { type: 'tableau', index: 0 },
      to: { type: 'tableau', index: 1 },
    })

    // Same split without the foundation being ready = pure rearrangement → not useful.
    expect(
      findFirstUsefulMove(
        board({
          tableau: tableau(),
          foundations: {
            ...emptyFoundations(),
            spades: foundationPileThrough('spades', 7),
          },
        })
      )
    ).toBeNull()
  })

  it('hints a draw when a reachable stock card plays somewhere (draw 1)', () => {
    // 5♦ is buried mid-stock; with draw 1 every stock card surfaces.
    const result = findFirstUsefulMove(
      board({
        tableau: [[card('clubs', 6)], [card('spades', 9)], ...fillers()],
        stock: [card('spades', 10), card('diamonds', 5), card('hearts', 2)],
        drawCount: 1,
      })
    )
    expect(result).toEqual({ kind: 'draw' })
  })

  it('is draw-count aware: the same stock can be dead at draw 3', () => {
    // Stock [9♠, 5♦, 2♥] (2♥ drawn next). Draw 3 takes all three in one tap
    // and only 9♠ ever shows as the waste top — the playable 5♦ never
    // surfaces, so there is no useful move.
    const stock = () => [card('spades', 9), card('diamonds', 5), card('hearts', 2)]
    const tableau = () => [[card('clubs', 6)], [card('spades', 10)], ...fillers()]

    expect(
      findFirstUsefulMove(board({ tableau: tableau(), stock: stock(), drawCount: 3 }))
    ).toBeNull()
    expect(
      findFirstUsefulMove(board({ tableau: tableau(), stock: stock(), drawCount: 1 }))
    ).toEqual({ kind: 'draw' })
  })

  it('returns null on a fully dead board and on an empty board', () => {
    expect(
      findFirstUsefulMove(
        board({ tableau: [...fillers(), [card('clubs', 8)], [card('spades', 11)]] })
      )
    ).toBeNull()
    expect(findFirstUsefulMove(board())).toBeNull()
  })
})

describe('draw-3 phase shift across a waste play (research nuance)', () => {
  // Entry order of the pile (draw 3): K♠, K♥ | 6♥ just surfaced as waste top,
  // 9♦ and K♣ still in stock. 9♦ never surfaces without a play: pass 1 groups
  // the remaining stock as [9♦, K♣] → top K♣; the recycled pass groups
  // [K♠, K♥, 6♥][9♦, K♣] → tops 6♥ and K♣. Playing 6♥ out of the waste
  // regroups the recycled pass to [K♠, K♥, 9♦][K♣] → 9♦ NOW surfaces. The
  // heuristic stays correct because the enabling play is itself useful, and
  // each committed move re-runs the simulation fresh.
  const wasteBefore = () => [card('spades', 13), card('hearts', 13), card('hearts', 6)]
  // App stock order: LAST element is drawn next → 9♦ before K♣… the pass
  // draws 9♦ first, so the array is [K♣, 9♦].
  const stockBefore = () => [card('clubs', 13), card('diamonds', 9)]
  const tableauBefore = () => [[card('spades', 7)], [card('spades', 10)], ...fillers()]

  it('before the play: 9♦ is unreachable, the waste 6♥ is the useful move', () => {
    const reachableCodes = collectReachableWasteTops(stockBefore(), wasteBefore(), 3).map(
      (c) => `${c.suit}-${c.rank}`
    )
    expect(reachableCodes).toContain('clubs-13')
    expect(reachableCodes).toContain('hearts-6')
    expect(reachableCodes).not.toContain('diamonds-9')

    expect(
      findFirstUsefulMove(
        board({
          tableau: tableauBefore(),
          stock: stockBefore(),
          waste: wasteBefore(),
          drawCount: 3,
        })
      )
    ).toEqual({
      kind: 'move',
      card: 'h6',
      from: { type: 'waste' },
      to: { type: 'tableau', index: 0 },
    })
  })

  it('after the play: the fresh simulation sees 9♦ surface → draw becomes useful', () => {
    const wasteAfter = [card('spades', 13), card('hearts', 13)]
    const tableauAfter = [
      [card('spades', 7), card('hearts', 6)],
      [card('spades', 10)],
      ...fillers(),
    ]

    const reachableCodes = collectReachableWasteTops(stockBefore(), wasteAfter, 3).map(
      (c) => `${c.suit}-${c.rank}`
    )
    expect(reachableCodes).toContain('diamonds-9')

    expect(
      findFirstUsefulMove(
        board({
          tableau: tableauAfter,
          stock: stockBefore(),
          waste: wasteAfter,
          drawCount: 3,
        })
      )
    ).toEqual({ kind: 'draw' })
  })
})

describe('collectReachableWasteTops', () => {
  it('collects group tops for the current stock pass and one recycled pass', () => {
    // Waste w0..w2 (w2 top), stock s0..s3 (s3 drawn next), draw 3.
    const waste = [card('hearts', 2), card('hearts', 3), card('hearts', 4)]
    const stock = [card('clubs', 5), card('clubs', 6), card('clubs', 7), card('clubs', 8)]
    const tops = collectReachableWasteTops(stock, waste, 3).map(
      (c) => `${c.suit}-${c.rank}`
    )
    // Pass 1 (stock draw order 8♣,7♣,6♣,5♣): groups [8,7,6]→6♣, [5]→5♣.
    // Pass 2 (entry order 2♥,3♥,4♥,8♣,7♣,6♣,5♣): tops 4♥, 6♣, 5♣.
    expect(tops).toEqual(['clubs-6', 'clubs-5', 'hearts-4', 'clubs-6', 'clubs-5'])
  })

  it('draw 1 reaches every card; empty piles reach nothing', () => {
    const stock = [card('clubs', 5), card('clubs', 6)]
    expect(collectReachableWasteTops(stock, [], 1)).toHaveLength(2)
    expect(collectReachableWasteTops([], [], 3)).toEqual([])
  })
})

describe('hasUsefulMove', () => {
  it('mirrors findFirstUsefulMove', () => {
    expect(
      hasUsefulMove(board({ tableau: [[card('hearts', 1)], ...fillers(), []] }))
    ).toBe(true)
    expect(hasUsefulMove(board())).toBe(false)
  })
})
