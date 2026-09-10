# Rewind to last winnable move

## User prompt

> you can press and hold undo to go back to the move where you can still solve the deck, but this is not clear. Can we improve the UX somehow?

> [2026-09-10, after the first five commits] Add a demo fixture `soli://?demo=deadend` that deals a deterministic game and replays it into a position that is *provably unwinnable*, while the earlier part of its history is *provably winnable*, so a rewind boundary genuinely exists and the feature can be exercised in one link. The dead end must be real, not assumed: verify with the Rust solver that the position after the bad move(s) is `unsolvable` and the position before them is `solved`. Plus: `?set=warnings:unwinnable` did not apply on a physical phone while `hintButton:on` and `rewind:on` in the same link did — investigate `resolveWarningLinkUpdate` and the `?set=` parsing, fix it if it is a bug, and say what else could explain the device behaviour if it is not.

## Summary

Three independent changes on branch `feat/rewind-to-last-winnable-move`, in nine commits.

1. **Rewind to last winnable move** (opt-in setting, default off). While a solver-proven warning is outstanding, the app binary-searches the game's timeline for the deepest position it can still *prove* winnable, marks it on the scrubber track, and offers one pill that jumps straight there via the existing `SCRUB_TO_INDEX`.
2. **The undo-scrubber hint schedule was loosened** from lifetime > 50 / streaks 10-20-30 to lifetime > 8 / streaks 3-6-9, because the old schedule almost never fired — which is *why* the player in the prompt had never learned the real gesture.
3. **A solver-verified dead-end fixture** (`soli://?demo=deadend`, `yarn deadend`). Every other interesting state in this app has a fixture; the one state this feature actually needs did not, so reaching it meant dealing random games until one died. The fixture replays 81 steps of the known solution and then plays one deliberately bad move, with both solver verdicts pinned as tests.

Status: code complete, all three gates green (`yarn typecheck && yarn lint && yarn jest` → 37 suites, 398 tests) plus `cargo test -p soli-solver-ffi` (17 tests). **Not yet verified on a device or simulator** — see "Testing".

## Description

The prompt is factually wrong about the current app in both halves, and the reframing *is* the feature. See "Intermediary learnings" — that section is the justification for everything below.

What the player is really doing today: they turn on the unwinnable warning, see "No winning moves left", tap Undo once, wait out the 600 ms background-solver debounce, see whether the warning comes back, and repeat. That is a **linear search performed by hand**, with no feedback about where the boundary is. The app already has everything needed to do that search properly and show the answer — it just never did.

Why it is cheap: `useHint.ts` already documents the invariant that a forward move can never revive a dead game. Winnability is therefore monotonically decreasing along a play line, so the timeline splits into a winnable prefix and an unwinnable suffix and the boundary is a **binary search**: ~7 solver calls for a 100-move game instead of ~100. Measured solver cost (`docs/product/hints/hints-and-unwinnable-warning.md`): median 0.5 ms, played-out positions proved dead in single-digit ms.

Why it is nice: it turns the most frustrating moment in the game ("you already lost, ten moves ago, good luck finding out where") into one tap plus a visible mark on the timeline. And it costs nothing when off.

## Acceptance Criteria

| When | Then |
|---|---|
| Setting off (default) | Nothing changes anywhere. No extra solver calls, no marker, no pill. |
| Setting on, no warning showing | Nothing changes. The search only runs while a warning is outstanding. |
| Setting on, warning outstanding, boundary proven | A **Rewind** pill appears in the dock's left half (`testID rewind-to-winnable`), and an amber tick appears on the scrubber track at that index while dragging. |
| Rewind pressed | The board jumps to that index via `SCRUB_TO_INDEX`. History, redo and the move log behave exactly as after a manual scrub. The warning clears (the scrub exits the dead era), the pill and marker disappear. |
| Setting on, warning outstanding, **nothing** proven winnable (e.g. the deal itself was unwinnable, or the solver ran out of budget) | Nothing is shown. The feature never claims a boundary the solver did not prove. |
| Hint button also on, warning outstanding | The Rewind pill takes the Hint button's slot for the duration of the warning. |
| Undo hint | Fires after 8 lifetime undo taps + a 3-undo streak (was 50 + 10). |

## Possible approaches

**The search itself**

- **A. Binary search over history snapshots (chosen).** Pros: ~log2(n) solver calls; provably correct given the monotonicity invariant the app already relies on; no new persistence, since `GameState.history` is already `GameSnapshot[]` and `buildSolverRequest` accepts any snapshot. Cons: needs care around `unknown` verdicts (see below).
- B. Linear scan backwards from the current position. Pros: trivially correct, no monotonicity assumption. Cons: ~100 solver calls on a long game, and it is exactly the thing the player is already doing by hand.
- C. Track winnability incrementally as the game is played. Pros: answer is always ready. Cons: a solver call after *every* move even when the feature is never used; the background check already only runs in `unwinnable` mode.

**Where the action lives**

- **A. A pill in the dock's left half, taking the Hint button's slot while a warning is outstanding (chosen).** Pros: the only place a tappable control fits (the pan's `hitSlop` claims 50 px *above* the Undo pill, so nothing tappable may sit there); during a dead era the Hint button is inert anyway — a press only re-affirms the warning (useHint F15 decision table, case 1). Cons: the re-affirm pulse is unreachable while the Rewind pill is up. Accepted: the pill is the better answer to the same question.
- B. A button inside the warning bubble. Cons: `GameNoticeBubble` is `pointerEvents="none"` and sits in the pan's hitSlop band; making it tappable would steal touches from the gesture.
- C. A third pill in the dock. Cons: no room without shrinking the Undo pill or entering the hitSlop band.

**`unknown` verdicts.** Treated as budget exhaustion, never as a verdict. The search widens to a neighbouring index rather than guessing a direction, and the returned index is always one the solver answered `winnable` for. If nothing can be proven the feature renders nothing.

## Open questions to the user

1. **Should the rewind also be offered in `noUsefulMoves` (classic) warning mode, or only in `unwinnable` mode?** Implemented: **both**. Reasoning: a dead era only ever starts on a solver `unsolvable` verdict — both `fireWarning` call sites in `useHint` are inside `status === 'unsolvable'` branches — so an outstanding warning in *either* mode already means the position is proven lost. Restricting to `unwinnable` would withhold a correct answer from the default warning mode for no reason. Trade-off: in `noUsefulMoves` mode the boundary may be far back (the game often died long before the deck played out), which could feel like a bigger jump than the player expects. Alternative if that reads badly on device: gate on `warningMode === 'unwinnable'` only — a one-line change.
2. **Should the pill hide the Hint button, or should the Hint button win?** Implemented: the pill wins while the warning is up. Alternative: keep Hint and drop the pill when both want the slot — rejected, since the Hint button does nothing useful inside a dead era.
3. **Copy: "Rewind".** Alternatives considered: "Last winnable" (accurate, too long for the pill), "Go back" (vague). The a11y label carries the full meaning: "Rewind to last winnable move".

## Dependencies

None new. The only `package.json` change is the `yarn deadend` script (a `scripts/deeplink.js` shortcut, no dependency).

## UX/UI Considerations

- The dock is deliberately plain React Native + Reanimated. Tamagui / expo-ui controls conflict with the pan gesture, which is why the Hint button is a bare `Pressable` placed **outside** `GestureWrapper`. The Rewind pill follows that pattern exactly and reuses `styles.hintButton`.
- Nothing tappable may live in the 50 px band above the Undo pill (the pan's `hitSlop`).
- The marker is a 3 pt amber (`COLOR_HINT`) tick, centred on the thumb centre for that index, so "drag until the thumb covers the tick" lands on exactly the marked move. It is only visible while the scrub overlay is up, i.e. while dragging.
- Both surfaces read the **same** computed index, so they cannot disagree.
- Every new interactive element carries an `accessibilityLabel` and a `testID`. The marker sits inside the already-`accessible` track node, so it cannot carry its own label — the index is appended to the track's label instead, prefix unchanged so existing recipes keep matching.

## Components

Reused: `DescribedSwitchRow` (settings row), `GameNoticeBubble` / `UndoHintBubble` (unchanged — no third bubble style invented), `UndoScrubber` (pill + marker added), the existing `SCRUB_TO_INDEX` action.

New: `src/solitaire/winnableBoundary.ts` (pure search), `src/features/klondike/scrubberMarker.ts` (pure geometry), `src/features/klondike/hooks/useRewindToWinnable.ts` (the async driver), `createDeadEndGameState` in the existing `src/solitaire/demoReplay.ts` (the fixture — deliberately NOT a new module: it reuses `getReplayFixtureEntry` / `foldReplayFixture` / `applyDemoReplayMoveForValidation` alongside the scrubbed and near-win fixtures).

## How to fetch data, how to cache

No new persistence. `GameState.history` is already `GameSnapshot[]` and every snapshot carries the full board (stock, waste, foundations, tableau, drawCount), so `buildSolverRequest` can be pointed at any historical position directly.

Solver traffic goes through **useHint's existing replace-latest queue**, borrowed via its return value, so two solves can never overlap. The whole search is enqueued as a **single** task: the queue is replace-latest, so a job split across several queued tasks could have one silently dropped mid-run. In practice there is no contention — while a dead era is outstanding `useHint` issues zero solver calls (the era gates the background check, and a hint press only re-affirms), which is exactly when the search runs.

The result is cached in hook state keyed on the **warning era**, not the position: playing on inside a dead era changes the position key but, by the `DeadEraMarker` invariant, cannot change what the era means. So the search runs once per warning, not once per move.

## Related tasks

- `docs/product/hints/hints-and-unwinnable-warning.md` — the warning model, the dead-era invariant, solver budgets and measured costs.
- `docs/product/undo-scrubber-hint/undo-scrubber-hint.md` — the discovery hint; see its new "v5" section for the schedule change made here.

## Simplification ideas

- The search is a *generic* function over `readonly TSnapshot[]` plus a probe. That is both simpler (no klondike import) and what makes it testable with a fake solver.
- No new reducer action, no `MOVE_LOG_VERSION` bump, no new persisted state, no new bubble component, no second solver queue.
- `useHint`'s `warningText` memo was refactored into an `activeDeadEra` memo that both `warningText` and the new `warningEraKey` derive from — one gate instead of two copies of the same condition.
- Rejected as gold plating: an animated fly-to-marker transition; a confirmation dialog before the jump (undo/redo already covers regret); showing *how many* moves back the boundary is.

## Steps to implement

1. [x] Pure boundary search `src/solitaire/winnableBoundary.ts` + unit tests.
2. [x] Setting `hints.rewindToWinnable` (default off) + `DescribedSwitchRow` in the Gameplay section + `?set=rewind:on` deep-link key + tests.
3. [x] `useHint` exposes `warningEraKey` and `enqueueSolve`.
4. [x] `useRewindToWinnable` hook (search driver + `SCRUB_TO_INDEX` dispatch).
5. [x] Pure marker geometry `scrubberMarker.ts` + unit tests.
6. [x] `UndoScrubber`: Rewind pill (left slot) + amber track marker + a11y label suffix.
7. [x] Wire everything in `useKlondikeGame`.
8. [x] Loosen the undo-hint schedule (own commit) + update its plan doc and the testing skill.
9. [x] Testing skill: `?set=rewind` row, the combined verification link, a11y matrix rows.
10. [x] This plan doc.
11. [x] Dead-end fixture `createDeadEndGameState` + solver verification + unit tests + a pinned Rust test.
12. [x] `?demo=deadend` deep link, `yarn deadend` shortcut, `scripts/deeplink.js` entry.
13. [x] Testing skill: `?demo=deadend` catalog row, shortcut row, decision-tree entry, `?set=` troubleshooting row.
14. [x] Investigate the `?set=warnings:unwinnable` device report (see "Identified issues" #5) + regression tests.
15. [ ] **Device/simulator verification by the orchestrator** — see "Testing".

## Plan: Files to modify

New: `src/solitaire/winnableBoundary.ts`, `src/features/klondike/scrubberMarker.ts`, `src/features/klondike/hooks/useRewindToWinnable.ts`, `test/unit/solitaire/winnableBoundary.test.ts`, `test/unit/features/klondike/scrubberMarker.test.ts`, this doc.

Modified: `src/state/settings.tsx`, `app/(tabs)/settings.tsx`, `src/features/klondike/hooks/useHint.ts`, `src/features/klondike/hooks/useKlondikeGame.ts`, `src/features/klondike/hooks/useDemoGameLauncher.ts`, `src/features/klondike/components/UndoScrubber.tsx`, `src/features/klondike/undoHint.ts`, `src/features/klondike/hooks/useUndoHint.ts`, `test/unit/state/settingsHints.test.ts`, `test/unit/features/klondike/demoLinkParsing.test.ts`, `test/unit/features/klondike/undoHint.test.ts`, `.agents/skills/soli-testing/SKILL.md`, `docs/product/undo-scrubber-hint/undo-scrubber-hint.md`.

## Files actually modified

Exactly as planned above. Nine commits:

1. `Add pure winnable-boundary binary search`
2. `Add the "Rewind to winnable" setting and its deep-link key`
3. `Offer "rewind to last winnable move" while a warning is showing`
4. `Loosen the undo-scrubber hint schedule so it actually fires`
5. `Document rewind-to-winnable and its verification recipe`
6. `Add a solver-verified "dead end" demo fixture`
7. `Reach the dead-end fixture via soli://?demo=deadend`
8. `Pin the ?set=warnings:unwinnable link path end to end`
9. `Document the dead-end fixture and the ?set=warnings finding`

The dead-end round added: `src/solitaire/demoReplay.ts` (`createDeadEndGameState`), `test/unit/solitaire/demoReplay.deadend.test.ts` (new), `rust/soli-solver-ffi/tests/solver_tests.rs` (`dead_end_demo_fixture_boundary_is_real`), `src/features/klondike/hooks/useDemoGameLauncher.ts`, `package.json`, `scripts/deeplink.js`, `test/unit/features/klondike/demoLinkParsing.test.ts`, `.agents/skills/soli-testing/SKILL.md`, this doc.

## Intermediary learnings

**1. The premise of the user prompt is factually wrong about the current app — in both halves. This reframing is the whole justification for the feature.**

- *"You can press and hold undo"* — **there is no press-and-hold.** The undo pill carries `Gesture.Exclusive(undoPanGesture, undoTapGesture)` (`useUndoScrubber.ts:449`). A tap undoes one move; a horizontal **drag** (`.minDistance(5)`) opens the scrubber. A hold with no movement does nothing at all and falls through to the tap on release. The player had invented a gesture.
- *"…to go back to the move where you can still solve the deck"* — **nothing in the app computes that.** What the player is actually doing is reacting to the unwinnable warning, stepping back one move, waiting out the 600 ms background-solver debounce, and repeating until the warning stops re-appearing. A linear search by hand; the app never showed them the boundary.

So the report is not a bug report and not a request for a tooltip. It is a player describing a feature they *assumed* existed, plus evidence that they were never taught the gesture that does exist. Both halves became work: build the feature, and fix the discoverability of the gesture they misunderstood. Answering only the literal question ("make the press-and-hold clearer") would have documented a gesture that does not exist.

**2. Both warning modes are solver-proven, not just `unwinnable`.** Easy to assume the classic "no more useful moves" warning is heuristic-only. It is not: both `fireWarning` call sites in `useHint` sit inside `status === 'unsolvable'` branches, with the heuristic acting only as a cheap gate *before* the solver call. So an outstanding warning in either mode means the position is proven dead, and the rewind is meaningful in both.

**3. The dead era makes solver contention a non-issue.** While a warning era is outstanding, `useHint` issues zero solver calls — the era gates the background check entirely, and a hint press only re-affirms the warning. That is exactly when the boundary search runs, so borrowing the same replace-latest queue costs nothing. But the search must be enqueued as **one** task: split across several, a competing enqueue would silently drop one and the search would await a promise that never runs.

**4. The timeline index space is invariant under scrubbing; the history array is not.** Searching `[...history, current, ...future]` (exactly how `scrubToIndex` builds it) rather than just `history` means an undo inside the dead era moves entries between `history` and `future` without changing any index — so the computed boundary stays valid without recomputation.

**5. Mutation testing caught a test that proved nothing.** The first `unknown`-handling fixture placed the unproven position at a spot the binary search never probes, so the case passed against an implementation that treated `unknown` as a verdict. Fixtures now put the `?` exactly on a search midpoint, and the suite is verified to fail against three mutations (unknown-as-unwinnable, unknown-as-winnable, dropped probe cache). Lesson worth keeping: a test for a *search* has to be written against the search's actual probe order.

**6. A dead end has to be searched for, not designed — and one bad move is enough at the right moment.** The first instinct ("bury a needed card") is unworkable by hand: at 80 steps into playlist entry 0 the board has exactly **two** legal non-draw moves, so the space of "deliberately bad" moves is tiny and none of them kills anything. The method that worked was mechanical: enumerate every legal move (draws included) breadth-first from the fold point, dump each resulting board as a `buildSolverRequest` JSON, and let the Rust solver rank them. That found a 2-step kill on the first pass, and the killing move turned out to be one a *real player would make* — the K♠ into the only empty column. Filling that column blocks the sole route to unload the column hiding the A♠, and the solver flips from `solved` to `unsolvable` on that one move. Both throwaway harnesses (a jest generator, a `cargo run --example` verdict printer) were deleted; what stayed is the pinned pair of verdicts.

**7. Pinning the verdicts needs BOTH sides, because neither half can catch drift alone.** The TS fixture throws on playlist drift (`applyDemoReplayMoveForValidation`), but it cannot prove the resulting board is dead — the solver is not reachable from jest. The Rust test can prove a board is dead, but it only knows the board someone typed into it. So the TS suite pins the exact `buildSolverRequest` JSON the fixture produces and the Rust suite pins that same JSON's verdict: drift on either side fails a gate. Pinning only the Rust half would have left a fixture that could quietly become winnable again.

**8. `?set=warnings:unwinnable` is NOT a parsing bug — the whole link path is correct, end to end.** The device report was investigated by driving the *real* `processDemoLink` (not just the pure parser) with the real URL, and it applies `warningMode: 'unwinnable'` correctly with the `#retry-<nonce>` fragment present, with the key first, middle or last in the list, and via the `unwinnableWarning:on` alias from the default mode. `resolveWarningLinkUpdate` is also correct in both directions: `{set: <mode>}` is unconditional, and every alias row of the truth table was re-derived. The refuse-to-downgrade rule only ever guards `stuckWarning:*`, never an upgrade to `unwinnable`. See "Identified issues" #5 for what can explain the device observation instead — the leading candidate is that `warnings:unwinnable` is the one key in that link with **no immediately visible effect**, which is exactly the gap the dead-end fixture closes.

**9. The undo-hint's 3/6/9 schedule is not a new guess.** The v2 Android smoke (2026-07-07) was run at exactly lifetime > 0 / streaks 3/6/9 and all seven checks passed. The shipped 50 / 10-20-30 values were the conservative guess that was never validated as a *discoverable* schedule.

## Identified issues

| # | Issue | Status |
|---|---|---|
| 1 | The Rewind pill hides the Hint button while a warning is outstanding, so the hint-press re-affirm pulse is unreachable during that time. | Accepted by design (the pill answers the same question better). Revisit if it reads badly on device. |
| 2 | In `noUsefulMoves` mode the boundary can be far back, so the jump may feel bigger than expected. | Open — needs a device opinion. One-line fix available (gate on `unwinnable` only). |
| 3 | The marker is only visible while the scrub overlay is up (i.e. while dragging), so a player who never drags only ever sees the pill. | Accepted: the pill is the discoverable surface; the marker is for players already in the gesture. |
| 4 | If a game is already unwinnable at the deal (possible with "Solvable deals" off), the search proves nothing winnable and the feature shows nothing. | Correct by design — verify it on device (test 6 below). |
| 5 | Device report: `?set=warnings:unwinnable` "did not apply" while `hintButton:on` / `rewind:on` in the same link did. | **No bug found; no fix made** (learning 8). The link path is now covered end to end by `demoLinkParsing.test.ts` (`?set= links through processDemoLink`). Remaining explanations, most likely first: (a) it *did* apply, but `warnings:unwinnable` is the only key in that link with no immediately visible effect — the warning fires only once the solver proves the CURRENT position dead, which on a live deal may never happen; (b) the settings write is async (`Storage.setItem`) and the fixture shortcuts force-stop by default, so a cold link fired right after a `?set=` link can drop the pending write — that would lose all three keys, but a re-check after only the *visible* two had already been confirmed would read as "warnings didn't apply"; (c) the phone ran a build older than the `warnings:` key. Diagnosis recipe added to the testing skill's troubleshooting table (the `[Demo] Settings link applied` / `ignored unknown pair` log lines answer "did it parse?" directly). Reopen with a `[SoliDev]` log capture if it recurs. |

## Testing

**Gates (run after every step, all green):** `yarn typecheck && yarn lint && yarn jest` → 37 suites, 398 tests. The dead-end fixture also has a Rust gate: `cd rust && cargo test -p soli-solver-ffi` → 17 tests (not part of the JS gates; run it if you touch the fixture constants).

Unit coverage added:

- `test/unit/solitaire/winnableBoundary.test.ts` — monotone timeline; boundary at index 0; boundary at the last index; all-winnable; all-unwinnable; empty timeline (zero solver calls); binary-search-not-scan (63 positions in ≤ 8 probes); `unknown` widening left and right; never claiming an unproven index; never re-probing a cached `unknown`; probe budget honoured. Verified to fail against three mutations.
- `test/unit/features/klondike/scrubberMarker.test.ts` — marker centres on the thumb centre for the same index; both ends of the travel; linear in between; clamping; degenerate track width / slider max. Verified to fail against three mutations.
- `test/unit/state/settingsHints.test.ts` — new toggle's default, round-trip, `current`-not-`DEFAULT` fallback, junk values, and that pre-feature payloads (including legacy `hintsEnabled:true`) leave it off.
- `test/unit/features/klondike/demoLinkParsing.test.ts` — `rewind:on` / `rewindToWinnable:off` / combined with `warnings:`, and junk values landing in `ignoredPairs`. Plus (issue #5) an end-to-end `?set= links through processDemoLink` block that renders the real hook and delivers a real `soli://` URL: `warnings:unwinnable` next to the other keys, with the `#retry-<nonce>` fragment, with the key not last, and through the `unwinnableWarning:on` alias.
- `test/unit/features/klondike/undoHint.test.ts` — updated to the 3/6/9 schedule, with the constants pinned directly so a silent drift back to 10/20/30 fails.
- `test/unit/solitaire/demoReplay.deadend.test.ts` — the fixture's recipe constants, deal identity, Auto Up off, timeline depths (82 snapshots / 82 move-log entries), determinism, the king landing in the only empty column, the replay validation throwing when the killing move is applied one step early, and the exact `buildSolverRequest` JSON for both boards.
- `rust/soli-solver-ffi/tests/solver_tests.rs` — `dead_end_demo_fixture_boundary_is_real` pins `solved` before the killing move and `unsolvable` after it.

### What the orchestrator must verify on the simulator

Not verified by this branch — the agent that wrote it was code-and-unit-tests only. Read `.agents/skills/soli-testing/SKILL.md` first. All links below need `--ios` when targeting the simulator.

**Setup**

```bash
yarn deeplink 'soli://?set=warnings:unwinnable,rewind:on' --ios
yarn deadend --ios
```

`yarn deadend` replaces the old recipe ("play badly on purpose until the warning appears"), which took minutes and produced a different board every time. The fixture lands on a position the solver has been *proven* to call `unsolvable`, on a history whose step-81 position is *proven* `solved` — so the warning fires ~600 ms after load (in `unwinnable` mode the background check runs on every position change) and the boundary the Rewind pill offers must be **index 81** of an 83-index timeline. Anything else is a bug in the search, not in the fixture.

The fixture is deliberately parameterless and the solver verdicts behind it are pinned in both suites (`demoReplay.deadend.test.ts`, `dead_end_demo_fixture_boundary_is_real`), so `boundary=81` is a hard expectation, not an observation. `?set=` first, fixture second: the fixture shortcut force-stops the app, and the settings write is async.

**a11y handles**

| Thing | Android (content-desc) | iOS (testID) |
|---|---|---|
| Rewind pill | `Rewind to last winnable move` | `rewind-to-winnable` |
| Warning bubble | `No winning moves left — undo or start a new game.` | `hint-bubble` |
| Scrubber track (carries the marker index) | `Undo scrubber, position N of M, last winnable move K` | `undo-scrubber-track` |
| Marker view | — (child of the accessible track) | `undo-scrubber-winnable-marker` |
| Undo pill | — | `undo` |

**Log line** (plain `console.log`, no developer mode needed): `[rewind] boundary=<index> timeline=<length>`. `boundary=-` means nothing was proven.

**Checks**

1. **Off by default.** `?set=warnings:unwinnable,rewind:off`, then `yarn deadend` → warning shows, **no** Rewind pill, no marker, no `[rewind]` log line.
2. **Pill appears.** With `rewind:on`, `yarn deadend` → warning bubble **and** the Rewind pill in the dock's left half. The log line must read exactly `[rewind] boundary=81 timeline=83` — the fixture's boundary is pinned, so any other number is a real bug in the search.
3. **The jump.** Tap `rewind-to-winnable` → the board changes, the warning bubble disappears, the pill disappears, the marker disappears. Then tap Undo/Redo: undo and redo still work normally from the landed position (this is what "behaves exactly like a manual scrub" means).
4. **It really is winnable.** After the jump, turn the Hint button on (`?set=hintButton:on`) and press Hint — it must return a *move* hint, not the "No winning moves left" re-affirm. This is the check that the boundary is real.
5. **The marker.** `yarn deadend` again, then start a scrub drag from the Undo pill (iOS: Appium `node scripts/ios-scrub.js`, per skill section 6 — agent-device cannot pan on iOS). While dragging, the amber tick must be visible on the track and the track's a11y label must read `…, last winnable move 81`. Dragging until the thumb covers the tick must land on index 81.
6. **Honest degradation.** `?set=solvableOnly:off`, then deal until you hit a deal that warns immediately at move 0 (roughly one in five). Expect: warning shows, **no** pill, no marker, `[rewind] boundary=- timeline=1`. The feature must show nothing rather than claim a boundary.
7. **Hint-slot swap.** With both `hintButton:on` and `rewind:on`: on a fresh deal the Hint pill is in the left slot; after `yarn deadend` the Rewind pill replaces it; after the rewind the Hint pill returns.
8. **Undo hint (independent of the rest).** `yarn deeplink 'soli://?reset=undoHint' --ios`, then tap Undo 3× in a row → the hint bubble appears with the "Drag the Undo button sideways…" copy (`undo-hint`). New deal, 6 in a row → hint 2. New deal, 9 in a row → hint 3.

**Regression watch:** with the setting off, the dock must render exactly as before (Hint pill placement, scrub overlay, warning bubble) — the whole feature is inert when off.

## Follow-ups

1. **Announce the rewind for screen readers.** The pill has a label, but the *result* of the jump is not announced. Pro: consistency with the warning/hint announcements. Con: another `announceForAccessibility` competing with the warning's own. Recommendation: add it if a VoiceOver pass shows the jump is silent.
2. **Show how far back the boundary is** ("Rewind 12 moves"). Pro: sets expectations before the jump, especially in `noUsefulMoves` mode where the jump can be long. Con: more copy in a tight pill, and the number changes as the player plays on inside the dead era. Recommendation: only if issue #2 above turns out to be real on device.
3. **Offer the rewind without a warning**, e.g. from the scrubber itself. Pro: helps players who play with warnings off. Con: it would mean running the solver during normal play (the exact battery cost the warning modes were designed to avoid) and it leaks winnability to players who deliberately turned warnings off. Recommendation: no.
4. **Gate on `unwinnable` mode only** if the long jumps in `noUsefulMoves` mode read badly (issue #2).
5. **Re-check the undo-hint schedule after real usage.** 3/6/9 is a deliberate loosening; if the bubble starts feeling naggy, the first lever is `UNDO_HINT_MAX_SHOWINGS`, not the streaks.
6. **A second dead-end fixture in `noUsefulMoves` mode.** `?demo=deadend` is dead but not *stuck* — draws are still legal — so it only triggers the warning in `unwinnable` mode; the classic mode warns at the fruitless recycle-flip, which this board has not reached. Pro: would let the `noUsefulMoves` path (and issue #2, the long-jump concern) be tested from a link too. Con: a second pinned board and a second pair of solver verdicts to maintain, for a mode whose warning path is already covered by the existing hint suites. Recommendation: only if issue #2 needs a device answer — otherwise reach that state by draining the stock from `?demo=deadend` by hand.
7. **Log the resolved warning mode on `?set=` links.** Today `[Demo] Settings link applied` logs the *requested* `warningUpdates`, not the mode they resolved to, so an alias link's outcome cannot be read off the log (issue #5). Pro: makes "did it apply?" answerable from `--logs` alone. Con: the resolved value is only known inside the functional setter, so logging it accurately means passing the current mode into the launcher just for a log line. Recommendation: only if issue #5 recurs — the existing log already proves the key *parsed*, which is the part that was actually in doubt.
