import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo } from 'react-native'
import type { MutableRefObject } from 'react'

import type { GameState } from '../../../solitaire/klondike'
import {
  buildSolverRequest,
  parseSolverCardCode,
  parseSolverResponse,
  type SolverHint,
  type SolverResponse,
} from '../../../solitaire/solverBridge'
import { findFirstUsefulMove, hasUsefulMove } from '../../../solitaire/usefulMoves'
import type { WarningMode } from '../../../state/settings'
import { solvePosition } from '../../../../modules/soli-solver'
import { getCardAccessibilityLabel } from '../components/cards/accessibility'

// On-demand button hints get the full interactive budget; the automatic
// background check gets less — it reruns after every move, and a slow proof is
// simply retried on the next position (budgets are enforced inside Rust).
const HINT_BUDGET_MS = 1500
const BACKGROUND_BUDGET_MS = 800
const BACKGROUND_DEBOUNCE_MS = 600
// One shared duration for every hint visual (stock ring AND source/target
// rings) so all three hint kinds behave as one design.
const HINT_HIGHLIGHT_MS = 2500
// Transient notice durations (button-press feedback only — the proactive
// warnings became persistent/era-bound in F14 and use no timer at all).
const STUCK_NOTICE_MS = 6000
const NO_HINT_BUBBLE_MS = 2500

// Solver-proven warning (opt-in "Unwinnable warning" setting) — the strong
// claim, reserved for the exact engine.
export const UNWINNABLE_BUBBLE_TEXT = 'No winning moves left — undo or start a new game.'
// Classic stuck warning (default-on "No more moves warning" setting) — the
// weaker genre framing on purpose (research 2026-07-23: no mainstream app
// claims unwinnability from heuristics).
export const STUCK_BUBBLE_TEXT = 'No more useful moves — undo or start a new game.'
export const NO_HINT_BUBBLE_TEXT = 'No hint found.'

// Notice shown when a Hint press finds nothing (no winning line AND the
// classic enumeration is empty). Mid-stock we only say "no hint" — the classic
// stuck wording is reserved for the played-out deck (stock empty), mirroring
// the warning's own timing so the button never acts as a mid-deck oracle.
// Exported for unit tests.
export const getHintFallbackNoticeText = (stockLength: number): string =>
  stockLength === 0 ? STUCK_BUBBLE_TEXT : NO_HINT_BUBBLE_TEXT

// Hint visuals are deliberately DECOUPLED from game selection state (user
// feedback 2026-07-23): the earlier approach dispatched SELECT_* to reuse the
// selection/drop-target visuals, which turned out invisible for board moves,
// looked broken for foundation plays ("outline change on the ace"), and showed
// nothing for waste plays. Hints now render as a dedicated overlay
// (HintOverlayLayer) and never touch the reducer, so they cannot fight the
// player's own interactions.
type UseHintOptions = {
  state: GameState
  stateRef: MutableRefObject<GameState>
  // Two settings since F14:
  // - warningMode: ONE select for the proactive warning ('off' |
  //   'noUsefulMoves' | 'unwinnable') — the modes are a strictness ladder,
  //   see settings.tsx.
  // - hintButtonEnabled: the Hint button + its visuals.
  warningMode: WarningMode
  hintButtonEnabled: boolean
  demoPlaybackActiveRef: MutableRefObject<boolean>
}

// Cheap committed-position identity. moveCount covers plays/draws,
// history.length covers undo/scrub (which keep moveCount), exactId covers new
// deals/hydration; stock/waste lengths add cheap extra discrimination. UI
// bits (bubble, hint rings) and solve results are keyed to this so ANY board
// change invalidates them.
const positionKeyOf = (state: GameState): string =>
  `${state.exactId}|${state.moveCount}|${state.history.length}|${state.stock.length}|${state.waste.length}`

// Screen-reader narration for an applied hint (same announce channel as the
// bubbles). Exported for unit tests.
export const getHintAnnouncement = (hint: SolverHint): string => {
  if (hint.kind === 'draw') {
    return 'Hint: draw from the stock.'
  }
  const cardLabel = getCardAccessibilityLabel(parseSolverCardCode(hint.card))
  const target =
    // Column numbers are 1-based in a11y labels (see accessibility.ts).
    hint.to.type === 'tableau' ? `column ${hint.to.index + 1}` : 'the foundation'
  return `Hint: move ${cardLabel} to ${target}.`
}

type PositionKeyed = { positionKey: string }
type NoticeState = PositionKeyed & { text: string }
type HighlightState = PositionKeyed & { hint: SolverHint }

// Dead-era marker (F14 sticky warnings). Set the moment a warning fires (in
// either mode); records WHICH warning fired plus the era boundary: the deal
// and the history depth at the warn moment.
//
// THE INVARIANT (deserves spelling out — the whole warning model rests on it):
// forward moves can never revive a dead game. Playing on only consumes
// options, so every position at/inside the era (same exactId, history depth
// >= the boundary) is provably still dead. Therefore, while inside the era:
//   - the warning stays DISPLAYED (persistent, no timer — user feedback
//     2026-07-24: "keep showing it until it's not true anymore"), and
//   - NO further warning evaluation runs (no heuristic, no solver call) —
//     re-proving a monotone fact is pure waste. This is also what keeps a
//     stuck era stable across draws/recycles: they change the position key
//     but not the era.
// Exiting the era (undo/scrub below the boundary, new deal, hydrate/remount)
// clears the warning and re-arms evaluation.
type DeadEraMarker = {
  exactId: string
  historyLength: number
  mode: Exclude<WarningMode, 'off'>
}

const warningTextFor = (mode: DeadEraMarker['mode']): string =>
  mode === 'unwinnable' ? UNWINNABLE_BUBBLE_TEXT : STUCK_BUBBLE_TEXT

// Owns the hint/warning features: the on-demand Hint button solve and the
// debounced background warning evaluation (mode-dependent since F14). All
// solver traffic is funneled through one replace-latest queue so two solves
// never overlap.
//
// NOTE (user feedback 2026-07-23: "button flickers on every move" = no-go):
// there is deliberately NO solver-busy React state here anymore. The old
// setSolverBusy(true/false) around every solve fed a disabled/dimmed style on
// the Hint button, which blinked for the 1-2 frames each sub-ms background
// solve took — after every single move. Busy bookkeeping lives in refs only;
// overlapping button presses are absorbed by the replace-latest queue (a
// repeat solve of the same position is sub-ms and just restarts the ring
// timer, which is the wanted behavior anyway).
export const useHint = ({
  state,
  stateRef,
  warningMode,
  hintButtonEnabled,
  demoPlaybackActiveRef,
}: UseHintOptions) => {
  const positionKey = positionKeyOf(state)

  // Transient button-press notice ("No hint found." / stuck notice) — the old
  // position-keyed + timer behavior. The proactive warnings do NOT live here:
  // they are era-bound and persistent (deadEra below).
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [highlight, setHighlight] = useState<HighlightState | null>(null)
  // Dead era = the active warning (see DeadEraMarker). State drives the
  // bubble; the ref mirror gives effects/callbacks a synchronous read that is
  // updated in the same breath (setDeadEra), so the evaluation gate and the
  // hint-press decision can never act on a stale era.
  const [deadEra, setDeadEraState] = useState<DeadEraMarker | null>(null)
  const deadEraRef = useRef<DeadEraMarker | null>(null)
  // Bumped on every warning fire AND re-affirm; GameNoticeBubble replays its
  // entry emphasis on change (F15: a hint press during an outstanding warning
  // re-announces instead of hinting).
  const [warningEmphasisNonce, setWarningEmphasisNonce] = useState(0)

  const setDeadEra = useCallback((era: DeadEraMarker | null) => {
    deadEraRef.current = era
    setDeadEraState(era)
  }, [])

  const solveInFlightRef = useRef(false)
  // Replace-latest queue: solves cannot be cancelled in v1 (the Rust side has
  // no cancel hook wired yet), so a superseded request is simply dropped
  // before it starts, and results for outdated positions are ignored below.
  const pendingSolveRef = useRef<(() => Promise<void>) | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      for (const timer of [noticeTimerRef, highlightTimerRef]) {
        if (timer.current !== null) {
          clearTimeout(timer.current)
        }
      }
    }
  }, [])

  const drainSolveQueue = useCallback(async () => {
    if (solveInFlightRef.current) {
      return
    }
    solveInFlightRef.current = true
    try {
      while (pendingSolveRef.current) {
        const task = pendingSolveRef.current
        pendingSolveRef.current = null
        await task()
      }
    } finally {
      solveInFlightRef.current = false
    }
  }, [])

  const enqueueSolve = useCallback(
    (task: () => Promise<void>) => {
      pendingSolveRef.current = task
      void drainSolveQueue()
    },
    [drainSolveQueue]
  )

  // Serializes the board AT RUN time (not enqueue time) so a queued request
  // always solves the newest committed position.
  const makeSolveTask = useCallback(
    (
      source: 'hint' | 'auto',
      budgetMs: number,
      handle: (response: SolverResponse, keyAtRun: string, stale: boolean) => void
    ) =>
      async () => {
        const current = stateRef.current
        const keyAtRun = positionKeyOf(current)
        const request = buildSolverRequest(current, budgetMs)
        let response: SolverResponse
        try {
          response = parseSolverResponse(await solvePosition(JSON.stringify(request)))
        } catch (error) {
          response = { status: 'error', message: String(error) }
        }
        // Plain console.log on purpose (not devLog): device tests grep these
        // lines without requiring developer mode.
        console.log(
          `[solver] source=${source} status=${response.status} ms=${
            response.solveMs?.toFixed(1) ?? '-'
          } visited=${response.visited ?? '-'} moves=${response.winMovesRemaining ?? '-'}`
        )
        handle(response, keyAtRun, positionKeyOf(stateRef.current) !== keyAtRun)
      },
    [stateRef]
  )

  const showNotice = useCallback((text: string, key: string, durationMs: number) => {
    setNotice({ text, positionKey: key })
    AccessibilityInfo.announceForAccessibility(text)
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current)
    }
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null
      setNotice(null)
    }, durationMs)
  }, [])

  // Starts a dead era: persistent warning bubble + announcement + evaluation
  // block. The boundary is the warn-time position (callers guarantee via
  // stale checks that stateRef.current IS that position). No timer — the
  // warning outlives position changes inside the era by design (F14).
  const fireWarning = useCallback(
    (mode: DeadEraMarker['mode'], board: GameState) => {
      setDeadEra({
        exactId: board.exactId,
        historyLength: board.history.length,
        mode,
      })
      setWarningEmphasisNonce((nonce) => nonce + 1)
      AccessibilityInfo.announceForAccessibility(warningTextFor(mode))
    },
    [setDeadEra]
  )

  // One path for all hint kinds: 'draw' surfaces as the stock ring, 'move' as
  // the source/target overlay rings. Auto-clears after HINT_HIGHLIGHT_MS; a
  // repeated hint press lands here again and restarts the timer.
  const applyHintHighlight = useCallback((hint: SolverHint, key: string) => {
    setHighlight({ hint, positionKey: key })
    AccessibilityInfo.announceForAccessibility(getHintAnnouncement(hint))
    if (highlightTimerRef.current !== null) {
      clearTimeout(highlightTimerRef.current)
    }
    highlightTimerRef.current = setTimeout(() => {
      highlightTimerRef.current = null
      setHighlight(null)
    }, HINT_HIGHLIGHT_MS)
  }, [])

  // Classic fallback (F11): no winning line usable → hint the first useful
  // move from the same enumeration the stuck warning uses, with the normal
  // visuals; empty enumeration → transient notice (stuck wording only at the
  // played-out deck, mirroring the warning's own timing).
  const showClassicFallback = useCallback(
    (board: GameState, keyAtRun: string) => {
      const fallback = findFirstUsefulMove(board)
      if (fallback) {
        applyHintHighlight(fallback, keyAtRun)
        return
      }
      const noticeText = getHintFallbackNoticeText(board.stock.length)
      showNotice(
        noticeText,
        keyAtRun,
        noticeText === STUCK_BUBBLE_TEXT ? STUCK_NOTICE_MS : NO_HINT_BUBBLE_MS
      )
    },
    [applyHintHighlight, showNotice]
  )

  // Any committed board change (move/draw/undo/scrub/new deal) invalidates the
  // highlight. Rendering is ALSO gated on the position key below (instant hide
  // on the very frame of the change); this effect clears the stored state so a
  // scrub-away-and-back within the timer window cannot resurrect a stale ring.
  useEffect(() => {
    setHighlight((current) =>
      current && current.positionKey !== positionKey ? null : current
    )
  }, [positionKey])

  // Era exit: the player materially changes course — undo/scrub below the
  // warn-time depth, or a new deal (hydrate/remount clears trivially: the era
  // is in-memory only). Clears the warning and re-arms evaluation. Moves
  // DEEPER into the dead line keep the era (see the DeadEraMarker invariant).
  // Declared BEFORE the background-evaluation effect on purpose: effects run
  // in declaration order, so by the time that effect re-checks deadEraRef for
  // the new position, an exited era is already gone.
  useEffect(() => {
    const era = deadEraRef.current
    if (
      era &&
      (state.exactId !== era.exactId || state.history.length < era.historyLength)
    ) {
      setDeadEra(null)
    }
  }, [setDeadEra, state.exactId, state.history.length])

  // Changing the warning mode drops any active era: the user just changed
  // what they want to be told, so the old warning's claim (and its evaluation
  // block) must not linger. Evaluation re-arms under the new mode and re-warns
  // if that mode's condition holds. (No-op at mount — the era starts null.)
  useEffect(() => {
    setDeadEra(null)
  }, [setDeadEra, warningMode])

  // On-demand hint (the button). F15 decision table — ONE decision point for
  // the hint × warning interplay (user feedback 2026-07-24: a hint and a
  // "you can't win anymore" warning showing together is a contradiction):
  //
  //   1. Warning outstanding for the current era (either mode)
  //        → NO move hint, no solver call; re-affirm the warning instead
  //          (re-announce + bubble emphasis pulse). Inside a stuck era this
  //          re-affirms "No more useful moves…", never "No hint found.".
  //   2. No outstanding warning → solve:
  //        solved              → winning hint (F9 board-first).
  //        unsolvable          → fire-on-discovery: the press just PROVED the
  //                              position dead, so if the active mode would
  //                              warn here ('unwinnable' always;
  //                              'noUsefulMoves' when the stuck condition
  //                              holds), warn NOW instead of hinting —
  //                              otherwise the debounced background check
  //                              would raise the warning moments after we
  //                              showed a hint (the exact contradiction this
  //                              table kills). Mode wouldn't warn (mode off,
  //                              or noUsefulMoves with useful moves left /
  //                              mid-stock) → classic useful-move fallback,
  //                              which therefore leaks no winnability beyond
  //                              the user's chosen knowledge level.
  //        unknown             → classic fallback only. NEVER warn on an
  //                              unproven claim (budget miss).
  //   Note mode 'unwinnable' can only reach the fallback via 'unknown' or in
  //   the sub-second pre-background gap — never with a live warning, because
  //   the era would already be outstanding (case 1).
  const requestHint = useCallback(() => {
    const current = stateRef.current
    if (
      !hintButtonEnabled ||
      current.hasWon ||
      current.isAutoCompleting ||
      current.autoQueue.length > 0 ||
      // Demo playback drives the board itself; hint visuals would fight it.
      demoPlaybackActiveRef.current
    ) {
      return
    }
    // Case 1: outstanding warning. The era-exit effect keeps the ref honest
    // (a press always runs after commit+effects, so a non-null era here is
    // guaranteed to cover the current position).
    const era = deadEraRef.current
    if (era) {
      setWarningEmphasisNonce((nonce) => nonce + 1)
      AccessibilityInfo.announceForAccessibility(warningTextFor(era.mode))
      return
    }
    enqueueSolve(
      makeSolveTask('hint', HINT_BUDGET_MS, (response, keyAtRun, stale) => {
        if (stale) {
          return
        }
        switch (response.status) {
          case 'solved':
            if (response.hint) {
              applyHintHighlight(response.hint, keyAtRun)
            }
            // solved without hint = position already won → nothing to show.
            break
          case 'unsolvable': {
            const board = stateRef.current
            // Case 2, fire-on-discovery (see the decision table above).
            if (
              warningMode === 'unwinnable' ||
              (warningMode === 'noUsefulMoves' &&
                board.stock.length === 0 &&
                !hasUsefulMove(board))
            ) {
              fireWarning(
                warningMode === 'unwinnable' ? 'unwinnable' : 'noUsefulMoves',
                board
              )
              break
            }
            showClassicFallback(board, keyAtRun)
            break
          }
          case 'unknown':
            // Budget miss: identical fallback handling so the button leaks
            // nothing about winnability — but never a warning (unproven).
            showClassicFallback(stateRef.current, keyAtRun)
            break
          default:
            // invalid/error should not happen in production; keep the payload
            // in device logs for diagnosis, show nothing.
            console.warn('[solver] hint request failed', response)
        }
      })
    )
  }, [
    applyHintHighlight,
    demoPlaybackActiveRef,
    enqueueSolve,
    fireWarning,
    hintButtonEnabled,
    makeSolveTask,
    showClassicFallback,
    stateRef,
    warningMode,
  ])

  // Background warning evaluation: debounced after every committed position
  // change; skipped while winning/auto-completing/demo playback. Which check
  // runs is the warning mode's business alone — the F11 two-toggle precedence
  // dance (and its once-per-position dedupe refs) collapsed into this single
  // mode switch plus the sticky era.
  useEffect(() => {
    if (
      warningMode === 'off' ||
      state.hasWon ||
      state.isAutoCompleting ||
      state.autoQueue.length > 0
    ) {
      return
    }
    // Sticky-era gate (THE F14 invariant, spelled out on DeadEraMarker):
    // inside a dead era no evaluation runs at all — zero heuristic work, zero
    // solver calls — because forward moves cannot revive a dead game. Draws/
    // recycles inside a stuck era land here too (new position key, same era).
    // The era-exit effect above already cleared the ref if this position left
    // the era, so a non-null era always covers the current position.
    if (deadEraRef.current) {
      return
    }
    const key = positionKey
    const timer = setTimeout(() => {
      // Ref reads at fire time: demo playback drives the reducer rapidly and
      // must never trigger solver work; the board ref is guarded by the key
      // check (any board change re-runs this effect and clears the timer).
      if (demoPlaybackActiveRef.current) {
        return
      }
      const board = stateRef.current
      if (positionKeyOf(board) !== key) {
        return
      }
      // Re-check: a hint press may have fired the warning (fire-on-discovery)
      // while this timer was pending.
      if (deadEraRef.current) {
        return
      }
      // Classic stuck check (F11 semantics, unchanged in F14). Battery/
      // psychology decisions, in one place:
      // - Only evaluated at the recycle-flip moment (stock empty). Mid-stock
      //   the warning must stay silent — the classic genre contract is "you
      //   played the deck out", never a mid-deck oracle about unseen cards —
      //   so mid-stock we skip even the (µs-cheap) heuristic.
      // - The solver confirmation below runs ONLY in mode 'unwinnable' OR
      //   when the heuristic already says dead, which keeps the default mode
      //   ('noUsefulMoves') at (near) zero background solver work.
      const heuristicStuck =
        warningMode === 'noUsefulMoves' &&
        board.stock.length === 0 &&
        !hasUsefulMove(board)
      if (warningMode !== 'unwinnable' && !heuristicStuck) {
        return
      }
      enqueueSolve(
        makeSolveTask('auto', BACKGROUND_BUDGET_MS, (response, keyAtRun, stale) => {
          // The era re-check also covers the rare in-flight race: a hint
          // press can prove the position dead (fire-on-discovery) while this
          // background solve is queued behind it — don't fire twice.
          if (stale || keyAtRun !== key || deadEraRef.current) {
            return
          }
          if (response.status === 'unsolvable') {
            // Solver-proven dead → start the era for the active mode. No
            // per-position dedupe needed anymore: the era itself blocks any
            // re-evaluation until the player exits it, and re-warning AFTER
            // an exit-and-return is exactly the wanted re-arm behavior.
            fireWarning(
              warningMode === 'unwinnable' ? 'unwinnable' : 'noUsefulMoves',
              board
            )
          } else if (response.status === 'solved') {
            if (heuristicStuck) {
              // Heuristic false positive the solver gate just rescued — this
              // is the live counter of Microsoft-style wrong warnings we
              // prevented (foundation digs / rearrangements the enumeration
              // excludes on purpose). console.warn so device tests can grep it.
              console.warn(
                '[stuck-heuristic] false positive: no useful move found but position is solvable',
                {
                  positionKey: key,
                  drawCount: state.drawCount,
                  wasteLength: state.waste.length,
                  winMovesRemaining: response.winMovesRemaining,
                }
              )
            }
          } else if (response.status === 'invalid' || response.status === 'error') {
            console.warn('[solver] background check failed', response)
          }
          // 'unknown' (budget miss): suppress silently — a warning must never
          // rest on an unproven claim; the next position retries anyway.
        })
      )
    }, BACKGROUND_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [
    demoPlaybackActiveRef,
    enqueueSolve,
    fireWarning,
    makeSolveTask,
    positionKey,
    state.autoQueue.length,
    state.drawCount,
    state.hasWon,
    state.isAutoCompleting,
    state.waste.length,
    stateRef,
    warningMode,
  ])

  // The era as the RENDER sees it (F14): non-null for every position inside
  // the dead era. The gate mirrors the era-exit effect so the bubble hides on
  // the very frame an undo below the boundary commits (the effect then clears
  // the state); the mode gate covers the one render before a mode change's
  // clear effect runs.
  const activeDeadEra = useMemo(() => {
    if (
      !deadEra ||
      warningMode === 'off' ||
      state.exactId !== deadEra.exactId ||
      state.history.length < deadEra.historyLength
    ) {
      return null
    }
    return deadEra
  }, [deadEra, state.exactId, state.history.length, warningMode])

  // Persistent warning text: the era IS the warning.
  const warningText = activeDeadEra ? warningTextFor(activeDeadEra.mode) : null
  // Stable identity of the active era, for consumers that must do work ONCE
  // per warning rather than once per position (useRewindToWinnable's boundary
  // search). Deliberately excludes the live position: playing on inside a dead
  // era changes the position key but not the era, and by the DeadEraMarker
  // invariant it cannot change what the era means either.
  const warningEraKey = activeDeadEra
    ? `${activeDeadEra.exactId}|${activeDeadEra.historyLength}|${activeDeadEra.mode}`
    : null

  // Transient notice stays position-keyed: any board change hides it without
  // cleanup effects. It only ever originates from the Hint button. A live
  // warning outranks it (stronger, persistent claim — one bubble, one truth).
  const noticeText =
    hintButtonEnabled && notice && notice.positionKey === positionKey
      ? notice.text
      : null
  const hintBubbleText = warningText ?? noticeText
  // One output for both hint kinds since F13: HintOverlayLayer renders the
  // stock ring for 'draw' and the source/target rings + ghost for 'move', so
  // the caller no longer needs a separate stockPulse channel into TopRow.
  const activeHint: SolverHint | null =
    hintButtonEnabled && highlight && highlight.positionKey === positionKey
      ? highlight.hint
      : null

  return {
    requestHint,
    activeHint,
    hintBubbleText,
    // For GameNoticeBubble's emphasis replay (warning fire + re-affirm).
    warningEmphasisNonce,
    // Non-null while a solver-proven warning is showing (see warningEraKey).
    warningEraKey,
    // The app's ONE solver queue, lent to the other solver consumer
    // (useRewindToWinnable) so two solves can never overlap. Sharing the queue
    // rather than spawning a second one is deliberate: it is replace-latest, so
    // a borrower must enqueue its whole job as a SINGLE task (a job split into
    // several queued tasks could have one silently dropped mid-run). In
    // practice there is no contention at all — while a dead era is outstanding
    // this hook issues zero solver calls (the era gates the background check
    // and a hint press only re-affirms), which is exactly when the borrower
    // works.
    enqueueSolve,
  }
}
