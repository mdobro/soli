import {
  REWIND_PLAYBACK_MAX_STEP_MS,
  REWIND_PLAYBACK_MIN_STEP_MS,
  REWIND_PLAYBACK_TARGET_TOTAL_MS,
  planRewindSteps,
  resolveRewindStepDelayMs,
} from '../../../../src/features/klondike/constants'

// The rewind used to be one SCRUB_TO_INDEX, which teleported the board. It is
// now stepped playback: one index per tick, so the existing 90 ms card flights
// animate each undone move and the player sees what is being taken back.
//
// The bug this pacing exists to avoid: rewind distance varies enormously — 4
// moves in the stuck demo fixture, 40+ after a real mistake — so a fixed
// per-step delay either crawls or blurs.
describe('rewind step pacing', () => {
  it('clamps to the readable end for short rewinds', () => {
    // An even split of the target across 2 steps exceeds the cap, so it clamps.
    expect(resolveRewindStepDelayMs(1)).toBe(REWIND_PLAYBACK_MAX_STEP_MS)
    expect(resolveRewindStepDelayMs(2)).toBe(REWIND_PLAYBACK_MAX_STEP_MS)
  })

  it('clamps to the brisk end for long rewinds, never below half a card flight', () => {
    expect(resolveRewindStepDelayMs(200)).toBe(REWIND_PLAYBACK_MIN_STEP_MS)
    expect(resolveRewindStepDelayMs(1000)).toBe(REWIND_PLAYBACK_MIN_STEP_MS)
  })

  it('spends about the target total in between', () => {
    const steps = 12
    expect(resolveRewindStepDelayMs(steps) * steps).toBeCloseTo(
      REWIND_PLAYBACK_TARGET_TOTAL_MS,
      5
    )
  })

  it('never returns a delay outside the clamp, for any distance', () => {
    for (const steps of [0, 1, 3, 7, 25, 99, 1000, -4]) {
      const delay = resolveRewindStepDelayMs(steps)
      expect(delay).toBeGreaterThanOrEqual(REWIND_PLAYBACK_MIN_STEP_MS)
      expect(delay).toBeLessThanOrEqual(REWIND_PLAYBACK_MAX_STEP_MS)
    }
  })
})

describe('rewind step sequence', () => {
  it('walks one move at a time from the current position down to the boundary', () => {
    // Board at history length 10, boundary proven at 6: the player watches four
    // moves come back off, landing exactly on the boundary.
    expect(planRewindSteps(10, 6)).toEqual([9, 8, 7, 6])
  })

  it('ends ON the boundary, never past it', () => {
    const steps = planRewindSteps(215, 210)
    expect(steps[steps.length - 1]).toBe(210)
    expect(Math.min(...steps)).toBe(210)
  })

  it('matches the stuck demo fixture depth', () => {
    // The shipped fixture reports boundary=210 timeline=215 on device, i.e. a
    // history length of 214 at the dead end. Five steps back to the boundary.
    expect(planRewindSteps(214, 210)).toEqual([213, 212, 211, 210])
  })

  it('is descending and contiguous, so no move is skipped', () => {
    const steps = planRewindSteps(40, 3)
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i - 1] - steps[i]).toBe(1)
    }
  })

  it('is empty when there is nothing to rewind', () => {
    expect(planRewindSteps(6, 6)).toEqual([])
    // A boundary at or above the current position must never walk forwards.
    expect(planRewindSteps(6, 9)).toEqual([])
  })
})
