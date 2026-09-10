import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject } from 'react'

import type { GameAction, GameSnapshot, GameState } from '../../../solitaire/klondike'
import { buildSolverRequest, parseSolverResponse } from '../../../solitaire/solverBridge'
import {
  findLastWinnableIndex,
  type WinnableProbeResult,
} from '../../../solitaire/winnableBoundary'
import { solvePosition } from '../../../../modules/soli-solver'

// Per-probe budget. Same order as useHint's background check: the median solve
// is ~0.5 ms and a played-out position is proved dead in single-digit ms
// (docs/product/hints/hints-and-unwinnable-warning.md), so this is a ceiling
// for the rare hard position, not a typical cost. A probe that busts it comes
// back 'unknown' and the search widens instead of concluding.
const REWIND_PROBE_BUDGET_MS = 800

type UseRewindToWinnableOptions = {
  state: GameState
  stateRef: MutableRefObject<GameState>
  // The "Rewind to winnable" setting (default off).
  enabled: boolean
  // Stable identity of the outstanding solver-proven warning, from useHint;
  // null when no warning is showing.
  //
  // BOTH warning modes qualify, not just 'unwinnable': a dead era only ever
  // starts on a solver `unsolvable` verdict (see the two fireWarning call
  // sites in useHint), so an outstanding warning in either mode means "this
  // position is PROVEN lost" — precisely the situation this feature answers.
  warningEraKey: string | null
  // Borrowed from useHint so all solver traffic stays on one queue; see the
  // comment on useHint's return value for why the whole search is enqueued as
  // a single task.
  enqueueSolve: (task: () => Promise<void>) => void
  dispatch: Dispatch<GameAction>
}

// Maps a solver answer onto the search's three-valued verdict. Only a literal
// proof counts: 'unknown' (budget miss) AND 'invalid'/'error' are all
// non-answers, so the search widens rather than claiming a boundary.
const probeSnapshot = async (snapshot: GameSnapshot): Promise<WinnableProbeResult> => {
  const request = buildSolverRequest(snapshot, REWIND_PROBE_BUDGET_MS)
  let status: string
  try {
    status = parseSolverResponse(await solvePosition(JSON.stringify(request))).status
  } catch (error) {
    console.warn('[rewind] solver probe failed', error)
    return 'unknown'
  }
  if (status === 'solved') {
    return 'winnable'
  }
  return status === 'unsolvable' ? 'unwinnable' : 'unknown'
}

// Computes WHERE the game stopped being winnable, and offers the jump back to
// it (rewind-to-winnable plan). Async by necessity — the solver cannot be
// called from the reducer — so this follows useHint's shape: the reducer is
// only ever touched by an existing action, never by a new one.
export const useRewindToWinnable = ({
  state,
  stateRef,
  enabled,
  warningEraKey,
  enqueueSolve,
  dispatch,
}: UseRewindToWinnableOptions) => {
  // The proven boundary as a TIMELINE index (the same index space
  // SCRUB_TO_INDEX and the scrubber thumb use). null = nothing proven, which
  // is also the honest state while a search is still running.
  const [boundaryIndex, setBoundaryIndex] = useState<number | null>(null)
  // Generation guard: a superseded search's result is dropped. Solves cannot
  // be cancelled (no cancel hook on the Rust side yet, same as useHint), so a
  // stale run simply finishes into the void.
  const searchIdRef = useRef(0)

  const searching = enabled && warningEraKey !== null

  useEffect(() => {
    searchIdRef.current += 1
    setBoundaryIndex(null)
    if (!searching) {
      return
    }
    const searchId = searchIdRef.current
    enqueueSolve(async () => {
      if (searchIdRef.current !== searchId) {
        return
      }
      // Board read at RUN time (useHint's makeSolveTask does the same).
      const board = stateRef.current
      // The full timeline, exactly as scrubToIndex builds it: history, the
      // live board, then the redo future. GameState IS a GameSnapshot, so the
      // live board slots in without a conversion. Searching the WHOLE timeline
      // (rather than just history) keeps the index space invariant under
      // scrubbing — an undo inside the dead era moves entries from history to
      // future without changing any index.
      const timeline: GameSnapshot[] = [...board.history, board, ...board.future]
      const index = await findLastWinnableIndex(timeline, probeSnapshot)
      if (searchIdRef.current !== searchId) {
        return
      }
      // Plain console.log like useHint's solver line: device tests grep these
      // without needing developer mode.
      console.log(`[rewind] boundary=${index ?? '-'} timeline=${timeline.length}`)
      setBoundaryIndex(index)
    })
  }, [enqueueSolve, searching, stateRef, warningEraKey])

  // A rewind must go BACKWARDS. By the monotonicity invariant a proven-winnable
  // index is always below the current position while a warning is outstanding,
  // so this only ever rejects a contradiction between two solver runs — cheap
  // insurance against offering a button that would no-op.
  const canRewind = boundaryIndex !== null && boundaryIndex < state.history.length

  const rewindToWinnable = useCallback(() => {
    const index = boundaryIndex
    if (index === null || index >= stateRef.current.history.length) {
      return
    }
    // SCRUB_TO_INDEX on purpose, NOT a new reducer action: the jump has to be
    // indistinguishable from a manual scrub so history, redo and the move log
    // (and therefore replay and MOVE_LOG_VERSION) behave exactly as they
    // already do. The whole feature is a shortcut to a gesture the player
    // could perform by hand.
    dispatch({ type: 'SCRUB_TO_INDEX', index })
  }, [boundaryIndex, dispatch, stateRef])

  return {
    // Same value drives both surfaces (the action and the scrubber marker) so
    // they can never disagree.
    rewindIndex: canRewind ? boundaryIndex : null,
    rewindToWinnable,
  }
}
