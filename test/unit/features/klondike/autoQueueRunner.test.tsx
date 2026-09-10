import { act } from 'react'
import TestRenderer from 'react-test-renderer'

import { useAutoQueueRunner } from '../../../../src/features/klondike/hooks/useAutoQueueRunner'
import type {
  AutoAction,
  GameAction,
  GameState,
} from '../../../../src/solitaire/klondike'
import {
  card,
  createTestState,
  resetCardCounter,
  tableauWith,
} from '../../solitaire/helpers'

// Hook-level tests for the auto-complete queue runner, which had zero coverage —
// which is exactly why the board-lock freeze below shipped. The reducer is not
// involved here: the runner's whole job is "arm one timeout, dispatch one
// ADVANCE_AUTO_QUEUE", and these tests pin when it may and may not do that.

// React act() outside react-dom needs the env flag (React 19).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Production cadence (AUTO_QUEUE_MOVE_DELAY_MS / AUTO_QUEUE_INTERVAL_MS); spelled
// out here so the test pins the "moves wait longer than draws" contract itself.
const MOVE_DELAY_MS = 35
const INTERVAL_MS = 25

const QUEUED_MOVE: AutoAction = {
  type: 'move',
  selection: { source: 'tableau', columnIndex: 0, cardIndex: 0 },
  target: { type: 'foundation', suit: 'hearts' },
}

const runningState = (autoQueue: AutoAction[]): GameState =>
  createTestState({
    tableau: tableauWith([card('hearts', 1)]),
    autoQueue,
    isAutoCompleting: true,
  })

const setup = (options: { state: GameState; boardLocked?: boolean }) => {
  let state = options.state
  let boardLocked = options.boardLocked ?? false
  // Stable identity across rerenders on purpose: a changing dispatch identity would
  // re-run the effect by itself and hide the missing `boardLocked` dependency.
  const dispatchGameAction = jest.fn<void, [GameAction]>()

  const Harness = () => {
    useAutoQueueRunner({
      state,
      dispatchGameAction,
      moveDelayMs: MOVE_DELAY_MS,
      intervalMs: INTERVAL_MS,
      boardLocked,
    })
    return null
  }

  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<Harness />)
  })

  const rerender = () =>
    act(() => {
      renderer.update(<Harness />)
    })

  return {
    dispatchGameAction,
    advance(ms: number) {
      act(() => {
        jest.advanceTimersByTime(ms)
      })
    },
    setBoardLocked(next: boolean) {
      boardLocked = next
      rerender()
    },
    replaceState(next: GameState) {
      state = next
      rerender()
    },
    unmount() {
      act(() => {
        renderer.unmount()
      })
    },
  }
}

beforeEach(() => {
  resetCardCounter()
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('useAutoQueueRunner', () => {
  it('arms a timeout and dispatches one ADVANCE_AUTO_QUEUE per queued action', () => {
    const driver = setup({ state: runningState([QUEUED_MOVE, { type: 'draw' }]) })

    driver.advance(MOVE_DELAY_MS - 1)
    expect(driver.dispatchGameAction).not.toHaveBeenCalled()

    driver.advance(1)
    expect(driver.dispatchGameAction).toHaveBeenCalledTimes(1)
    expect(driver.dispatchGameAction).toHaveBeenCalledWith({ type: 'ADVANCE_AUTO_QUEUE' })

    // One timeout per effect run: without a state change nothing re-arms.
    driver.advance(MOVE_DELAY_MS * 5)
    expect(driver.dispatchGameAction).toHaveBeenCalledTimes(1)
    driver.unmount()
  })

  it('waits the shorter interval delay when the next action is a draw', () => {
    const driver = setup({ state: runningState([{ type: 'draw' }]) })

    driver.advance(INTERVAL_MS)
    expect(driver.dispatchGameAction).toHaveBeenCalledTimes(1)
    driver.unmount()
  })

  it('stays idle when there is no run in progress', () => {
    const driver = setup({ state: createTestState() })

    driver.advance(MOVE_DELAY_MS * 5)
    expect(driver.dispatchGameAction).not.toHaveBeenCalled()
    driver.unmount()
  })

  it('does not arm the timeout while the board is locked', () => {
    const driver = setup({ state: runningState([QUEUED_MOVE]), boardLocked: true })

    driver.advance(MOVE_DELAY_MS * 5)

    expect(driver.dispatchGameAction).not.toHaveBeenCalled()
    driver.unmount()
  })

  // Regression test for the board-lock freeze (2026-09-09). Before the fix the
  // runner armed its timeout regardless of the lock; the dispatch that fired was
  // then swallowed by dispatchGameAction's boardLockedRef guard, so no state
  // changed, the effect never re-ran, no new timeout was ever armed — and the game
  // sat at isAutoCompleting: true with a queue nobody advanced. `boardLocked` is a
  // dependency of the effect precisely so unlocking re-arms it.
  it('re-arms the run when the board lock clears without any state change', () => {
    const driver = setup({ state: runningState([QUEUED_MOVE]), boardLocked: true })

    driver.advance(MOVE_DELAY_MS * 5)
    driver.dispatchGameAction.mockClear()

    // Same state object as before — only the lock flips, exactly like a dialog
    // closing mid-run.
    driver.setBoardLocked(false)
    driver.advance(MOVE_DELAY_MS)

    expect(driver.dispatchGameAction).toHaveBeenCalledTimes(1)
    expect(driver.dispatchGameAction).toHaveBeenCalledWith({ type: 'ADVANCE_AUTO_QUEUE' })
    driver.unmount()
  })
})
