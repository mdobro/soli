import {
  CELEBRATION_PREVIEW_MOVES_MIN,
  CELEBRATION_PREVIEW_MOVES_SPAN,
  CELEBRATION_PREVIEW_SECONDS_MIN,
  CELEBRATION_PREVIEW_SECONDS_SPAN,
  resolveCelebrationPreviewStats,
} from '../../../../src/features/klondike/celebrationPreviewStats'
import { parseCelebrationStatsLinkParams } from '../../../../src/features/klondike/hooks/useDemoGameLauncher'
import { CELEBRATION_MODE_METADATA } from '../../../../src/animation/celebrationModes'
import { formatElapsedDuration } from '../../../../src/utils/time'

// Synthetic header stats for screenshot-mode celebration previews
// (store-screenshots round 3). The preview board was never played, so the real
// header would read MOVES 0 / TIME 0:00 in store shots.
describe('resolveCelebrationPreviewStats', () => {
  it('is deterministic per mode id (screenshots must be reproducible)', () => {
    expect(resolveCelebrationPreviewStats(36)).toEqual(
      resolveCelebrationPreviewStats(36)
    )
    // Different modes must not collide, otherwise every celebration shot in the
    // pool shows the identical pair.
    expect(resolveCelebrationPreviewStats(36)).not.toEqual(
      resolveCelebrationPreviewStats(46)
    )
  })

  it('keeps every real celebration mode inside the plausible band', () => {
    for (const entry of CELEBRATION_MODE_METADATA) {
      const stats = resolveCelebrationPreviewStats(entry.id)
      expect(stats.moveCount).toBeGreaterThanOrEqual(CELEBRATION_PREVIEW_MOVES_MIN)
      expect(stats.moveCount).toBeLessThan(
        CELEBRATION_PREVIEW_MOVES_MIN + CELEBRATION_PREVIEW_MOVES_SPAN
      )
      const seconds = stats.elapsedMs / 1000
      expect(Number.isInteger(seconds)).toBe(true)
      expect(seconds).toBeGreaterThanOrEqual(CELEBRATION_PREVIEW_SECONDS_MIN)
      expect(seconds).toBeLessThan(
        CELEBRATION_PREVIEW_SECONDS_MIN + CELEBRATION_PREVIEW_SECONDS_SPAN
      )
      // The header renders m:ss — 4:00..7:00 always formats as one clean pair.
      expect(formatElapsedDuration(stats.elapsedMs)).toMatch(/^[4-7]:[0-5]\d$/)
    }
  })

  it('applies explicit overrides and converts time from seconds', () => {
    expect(resolveCelebrationPreviewStats(36, { moves: 143, timeSeconds: 312 })).toEqual({
      moveCount: 143,
      elapsedMs: 312_000,
    })
    // Partial overrides keep the deterministic value for the other field.
    expect(resolveCelebrationPreviewStats(36, { moves: 143 })).toEqual({
      moveCount: 143,
      elapsedMs: resolveCelebrationPreviewStats(36).elapsedMs,
    })
  })

  it('ignores nonsense overrides instead of rendering NaN in the header', () => {
    expect(
      resolveCelebrationPreviewStats(36, { moves: Number.NaN, timeSeconds: -5 })
    ).toEqual(resolveCelebrationPreviewStats(36))
  })
})

// The link decides WHETHER synthetic stats apply; the resolver decides what they
// are. Plain dev previews keep the untouched board's real header.
describe('parseCelebrationStatsLinkParams', () => {
  it('synthesizes for screenshot-mode links', () => {
    expect(
      parseCelebrationStatsLinkParams({ screenshotMode: true, moves: null, time: null })
    ).toEqual({ moves: undefined, timeSeconds: undefined })
  })

  it('leaves a plain dev preview untouched', () => {
    expect(
      parseCelebrationStatsLinkParams({ screenshotMode: false, moves: null, time: null })
    ).toBeUndefined()
  })

  it('accepts &moves=/&time= overrides (and switches synthesis on without screenshot=1)', () => {
    expect(
      parseCelebrationStatsLinkParams({
        screenshotMode: false,
        moves: '143',
        time: '312',
      })
    ).toEqual({ moves: 143, timeSeconds: 312 })
  })

  it('falls back to the deterministic values for unparsable overrides', () => {
    expect(
      parseCelebrationStatsLinkParams({ screenshotMode: true, moves: 'abc', time: '' })
    ).toEqual({ moves: undefined, timeSeconds: undefined })
  })
})
