import {
  createGameStateFromExactId,
  klondikeReducer,
  type GameState,
} from '../../../src/solitaire/klondike'
import {
  buildSolverRequest,
  cardToSolverCode,
  parseSolverResponse,
  type SolverResponse,
} from '../../../src/solitaire/solverBridge'
import { card } from './helpers'

// 'E1_0' is permutation rank 0 = the canonical deck (clubs A..K, diamonds,
// hearts, spades) — a fully deterministic deal with no RNG involved, so the
// golden expectations below can be spelled out card by card.
const CANONICAL_EXACT_ID = 'E1_0'

const rankRange = (suit: 'c' | 'd' | 'h' | 's', from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${suit}${from + i}`)

// Every card of the request, including the ones implied by foundation counts
// (count n = ranks 1..n of that suit placed) — mirrors how Rust rebuilds the
// 52-card set for validation.
const allRequestCards = (request: ReturnType<typeof buildSolverRequest>): string[] => [
  ...(
    Object.entries(request.foundations) as Array<['c' | 'd' | 'h' | 's', number]>
  ).flatMap(([suit, count]) => rankRange(suit, 1, count)),
  ...request.tableau.flatMap((column) => [...column.hidden, ...column.visible]),
  ...request.stock,
  ...request.waste,
]

const createCanonicalState = (): GameState =>
  createGameStateFromExactId(CANONICAL_EXACT_ID, 1, { autoUpEnabled: false })

describe('buildSolverRequest', () => {
  it('serializes the canonical fresh deal exactly (golden fixture)', () => {
    const state = createCanonicalState()
    const request = buildSolverRequest(state, 1234)

    expect(request).toEqual({
      drawCount: 1,
      budgetMs: 1234,
      foundations: { c: 0, d: 0, h: 0, s: 0 },
      tableau: [
        { hidden: [], visible: ['c1'] },
        { hidden: ['c2'], visible: ['c3'] },
        { hidden: ['c4', 'c5'], visible: ['c6'] },
        { hidden: ['c7', 'c8', 'c9'], visible: ['c10'] },
        { hidden: ['c11', 'c12', 'c13', 'd1'], visible: ['d2'] },
        { hidden: ['d3', 'd4', 'd5', 'd6', 'd7'], visible: ['d8'] },
        { hidden: ['d9', 'd10', 'd11', 'd12', 'd13', 'h1'], visible: ['h2'] },
      ],
      // App stock order: LAST element is drawn next. The deal reveals the first
      // draw (s13) into the waste, so the stock ends at s12.
      stock: [...rankRange('h', 3, 13), ...rankRange('s', 1, 12)],
      waste: ['s13'],
    })

    const cards = allRequestCards(request)
    expect(cards).toHaveLength(52)
    expect(new Set(cards).size).toBe(52)
  })

  it('serializes a mid-game position after reducer moves (round-trip sanity)', () => {
    let state = createCanonicalState()
    // A♣ (column 1) to its foundation.
    state = klondikeReducer(state, {
      type: 'APPLY_MOVE',
      selection: { source: 'tableau', columnIndex: 0, cardIndex: 0 },
      target: { type: 'foundation', suit: 'clubs' },
    })
    // 2♦ (column 5 top) onto 3♣ (column 2 top) — flips d1 face up.
    state = klondikeReducer(state, {
      type: 'APPLY_MOVE',
      selection: { source: 'tableau', columnIndex: 4, cardIndex: 4 },
      target: { type: 'tableau', columnIndex: 1 },
    })
    state = klondikeReducer(state, { type: 'DRAW_OR_RECYCLE' })

    const request = buildSolverRequest(state, 800)

    expect(request.budgetMs).toBe(800)
    expect(request.foundations).toEqual({ c: 1, d: 0, h: 0, s: 0 })
    expect(request.tableau[0]).toEqual({ hidden: [], visible: [] })
    expect(request.tableau[1]).toEqual({ hidden: ['c2'], visible: ['c3', 'd2'] })
    expect(request.tableau[4]).toEqual({
      hidden: ['c11', 'c12', 'c13'],
      visible: ['d1'],
    })
    // Draw moved s12 onto the waste top (waste order: last = top/playable).
    expect(request.stock).toEqual([...rankRange('h', 3, 13), ...rankRange('s', 1, 11)])
    expect(request.waste).toEqual(['s13', 's12'])

    const cards = allRequestCards(request)
    expect(cards).toHaveLength(52)
    expect(new Set(cards).size).toBe(52)
  })
})

describe('cardToSolverCode', () => {
  it('maps aces and kings of every suit (rank 1..13 passthrough)', () => {
    expect(cardToSolverCode(card('clubs', 1))).toBe('c1')
    expect(cardToSolverCode(card('diamonds', 1))).toBe('d1')
    expect(cardToSolverCode(card('hearts', 1))).toBe('h1')
    expect(cardToSolverCode(card('spades', 1))).toBe('s1')
    expect(cardToSolverCode(card('clubs', 13))).toBe('c13')
    expect(cardToSolverCode(card('diamonds', 13))).toBe('d13')
    expect(cardToSolverCode(card('hearts', 13))).toBe('h13')
    expect(cardToSolverCode(card('spades', 13))).toBe('s13')
  })
})

describe('parseSolverResponse', () => {
  it('parses a solved response with a move hint', () => {
    const response: SolverResponse = {
      status: 'solved',
      solveMs: 1.8,
      visited: 3084,
      winMovesRemaining: 42,
      hint: {
        kind: 'move',
        card: 'd7',
        from: { type: 'tableau', index: 3 },
        to: { type: 'foundation' },
      },
    }

    expect(parseSolverResponse(JSON.stringify(response))).toEqual(response)
  })

  it('parses a draw hint and every known status', () => {
    expect(
      parseSolverResponse('{"status":"solved","hint":{"kind":"draw"}}').hint
    ).toEqual({ kind: 'draw' })

    for (const status of ['solved', 'unsolvable', 'unknown', 'invalid', 'error']) {
      expect(parseSolverResponse(`{"status":"${status}"}`).status).toBe(status)
    }
  })

  it('degrades malformed payloads to a synthetic error response', () => {
    expect(parseSolverResponse('not json').status).toBe('error')
    expect(parseSolverResponse('null').status).toBe('error')
    expect(parseSolverResponse('{"status":"weird"}').status).toBe('error')
  })
})
