// Synthetic MOVES/TIME for celebration PREVIEWS (store-screenshots round 3).
//
// Why: `soli://?celebration=<id>&screenshot=1` shows the full celebration on a
// board that was never played, so the header reads MOVES 0 / TIME 0:00 — which
// looks obviously fake in App Store / Play screenshots. Screenshot-mode previews
// therefore render a plausible pair instead.
//
// DISPLAY-ONLY BY DESIGN: the resolved values live on the celebration state
// (CelebrationState.previewStats) and are read exactly once, by the statistics
// HUD in useKlondikeGame. They never touch the reducer, the persisted game, or a
// history row — a preview is not a game, so nothing may record these numbers.
// Do not "simplify" this by hydrating moveCount/elapsedMs into GameState: that
// would pollute real state (autosave, history recovery, the win recorder).
//
// DETERMINISTIC: derived from the resolved mode id, never Math.random — the same
// deep link must produce the same screenshot on every re-fire and on every
// device. Ranges are the plausible band for a won Klondike game.

export type CelebrationPreviewStats = {
  moveCount: number
  elapsedMs: number
}

// Optional per-link overrides (`&moves=143&time=312`, time in seconds). An empty
// object still means "synthesize" — presence of the request is the gate.
export type CelebrationPreviewStatsRequest = {
  moves?: number
  timeSeconds?: number
}

const MILLISECONDS_PER_SECOND = 1_000

export const CELEBRATION_PREVIEW_MOVES_MIN = 120
// Exclusive span → 120..180 moves.
export const CELEBRATION_PREVIEW_MOVES_SPAN = 61
export const CELEBRATION_PREVIEW_SECONDS_MIN = 240
// Exclusive span → 4:00..7:00.
export const CELEBRATION_PREVIEW_SECONDS_SPAN = 181

// Strides are coprime with their spans so neighbouring mode ids don't land on
// neighbouring values (consecutive celebration shots look independently played).
const MOVES_STRIDE = 7
const SECONDS_STRIDE = 37

const sanitizeOverride = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined

export const resolveCelebrationPreviewStats = (
  modeId: number,
  request: CelebrationPreviewStatsRequest = {}
): CelebrationPreviewStats => {
  const seed = Number.isFinite(modeId) ? Math.abs(Math.trunc(modeId)) : 0
  const moveCount =
    sanitizeOverride(request.moves) ??
    CELEBRATION_PREVIEW_MOVES_MIN + ((seed * MOVES_STRIDE) % CELEBRATION_PREVIEW_MOVES_SPAN)
  const seconds =
    sanitizeOverride(request.timeSeconds) ??
    CELEBRATION_PREVIEW_SECONDS_MIN +
      ((seed * SECONDS_STRIDE) % CELEBRATION_PREVIEW_SECONDS_SPAN)

  return { moveCount, elapsedMs: seconds * MILLISECONDS_PER_SECOND }
}
