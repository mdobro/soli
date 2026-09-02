//! Request validation, mid-game state construction, threaded solve, and hint
//! derivation for the Soli hint/unwinnable feature.
//!
//! Hint selection is BOARD-FIRST (F9, 2026-07-23): when the position is
//! winnable, prefer a no-draw move the player can make right now — verified
//! by a budget-sliced sub-solve to keep the game winnable — and only hint
//! "draw" when no such move verifies. See `board_first_candidates` /
//! `pick_board_first_move`. The FFI contract is unchanged.
//!
//! Ordering conventions at the app↔lonelybot boundary (all verified by the
//! equivalence tests in tests/solver_tests.rs):
//! - Request `tableau[i].hidden`/`.visible` are bottom→top; lonelybot's
//!   `HiddenVec`/`PileVec` use the same order (last element = revealed next /
//!   top of the face-up run). Note: lonelybot reveals via `.pop()`, i.e. the
//!   LAST hidden element flips next — not the first.
//! - Request `stock` is app order (LAST element drawn next); lonelybot's
//!   `Deck` stores [waste bottom→top, then stock next-draw-FIRST→last], so we
//!   reverse the stock and append it after the waste, with
//!   `draw_cur = waste.len()`.
//! - The CDHS↔HDCS suit remap lives in protocol.rs, Rust-side only, so the TS
//!   side never sees lonelybot conventions (mirrors lonecli harvest-v2).

use std::num::NonZeroU8;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use lonelybot::card::{Card, N_RANKS};
use lonelybot::convert::convert_moves;
use lonelybot::deck::{N_DECK_CARDS, N_PILES};
use lonelybot::engine::SolitaireEngine;
use lonelybot::moves::{Move, N_MOVES_MAX};
use lonelybot::pruning::NoPruner;
use lonelybot::solver::{solve_with_tracking, HistoryVec, SearchResult};
use lonelybot::stack::Stack;
use lonelybot::standard::{HiddenVec, PileVec, Pos, StandardMove, StandardSolitaire};
use lonelybot::state::Solitaire;
use lonelybot::tracking::{SearchStatistics, TerminateSignal};

use crate::protocol::{
    app_card_index, format_app_card, parse_app_card, Hint, HintFrom, HintTo, Request, Response,
    Status, APP_SUIT_LETTERS, SUIT_REMAP,
};

const DEFAULT_BUDGET_MS: u64 = 1500;

/// Per-candidate verification budget for the board-first hint (F9): each
/// candidate sub-solve gets min(this, half the remaining request budget), so
/// one slow candidate can never eat the whole budget and the total stays
/// within the request deadline (the halves telescope). Mid-game sub-solves
/// are sub-ms in practice (see plan doc perf tables) — 200 ms is a generous
/// outlier guard, not the expected cost.
const CANDIDATE_SLICE_MS: u64 = 200;

/// lonelybot's search is a recursive DFS; mobile default thread stacks
/// (~0.5–1 MiB) are too small for deep lines, so every solve runs on its own
/// 4 MiB-stack thread (lonecli uses the same size).
const SOLVE_STACK_SIZE: usize = 4 * 1024 * 1024;

struct VisitCounter(AtomicU64);

impl SearchStatistics for VisitCounter {
    fn hit_a_state(&self, _depth: usize) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
    fn hit_unique_state(&self, _depth: usize, _n_moves: u32) {}
    fn finish_move(&self, _depth: usize) {}
}

/// The AtomicBool is unused in Phase A but is the hook for cooperative
/// cancellation from the app (Phase B) — same shape as lonecli's TermSignal.
struct DeadlineSignal {
    cancelled: AtomicBool,
    deadline: Option<Instant>,
}

impl TerminateSignal for DeadlineSignal {
    fn terminate(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
    fn is_terminated(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed) || self.deadline.is_some_and(|d| Instant::now() >= d)
    }
}

fn parse_cards(list: &[String], what: &str) -> Result<Vec<Card>, String> {
    list.iter()
        .map(|s| parse_app_card(s).map_err(|e| format!("{what}: {e}")))
        .collect()
}

/// Validates the request and builds the mid-game `StandardSolitaire`.
fn build_state(req: &Request) -> Result<StandardSolitaire, String> {
    if !(1..=9).contains(&req.draw_count) {
        return Err(format!("drawCount must be 1..=9, got {}", req.draw_count));
    }
    if req.tableau.len() != usize::from(N_PILES) {
        return Err(format!(
            "tableau must have exactly {N_PILES} columns, got {}",
            req.tableau.len()
        ));
    }

    let f = &req.foundations;
    let app_counts = [f.c, f.d, f.h, f.s];
    if app_counts.iter().any(|c| *c > N_RANKS) {
        return Err("foundation counts must be 0..=13".to_string());
    }

    // Foundations are implied cards: count = n means A..n of that suit placed.
    let mut all_cards: Vec<Card> = Vec::with_capacity(52);
    for (app_suit, count) in app_counts.iter().enumerate() {
        let lb_suit = SUIT_REMAP[app_suit];
        for rank in 0..*count {
            all_cards.push(Card::new(rank, lb_suit));
        }
    }

    let mut hidden_piles: [HiddenVec; N_PILES as usize] = Default::default();
    let mut piles: [PileVec; N_PILES as usize] = Default::default();
    for (i, col) in req.tableau.iter().enumerate() {
        let hidden = parse_cards(&col.hidden, &format!("tableau[{i}].hidden"))?;
        let visible = parse_cards(&col.visible, &format!("tableau[{i}].visible"))?;
        // Column i is dealt with i face-down cards and they only ever decrease;
        // this also keeps Hidden::from_piles inside its per-column capacity.
        if hidden.len() > i {
            return Err(format!(
                "tableau[{i}] has {} hidden cards (max {i})",
                hidden.len()
            ));
        }
        // A column with face-down cards always has a face-up card on top (the
        // app auto-flips); lonelybot's compact state cannot represent the
        // alternative, so reject it.
        if !hidden.is_empty() && visible.is_empty() {
            return Err(format!("tableau[{i}] has hidden cards but no visible card"));
        }
        // The face-up run must be a legal descending alternating-color
        // sequence (base card arbitrary). The solver's compact representation
        // assumes this; an illegal run would silently solve a different
        // position instead of failing.
        for w in visible.windows(2) {
            if !w[1].go_after(Some(w[0])) {
                return Err(format!(
                    "tableau[{i}] visible run is illegal at {}",
                    format_app_card(w[1])
                ));
            }
        }
        all_cards.extend(&hidden);
        all_cards.extend(&visible);
        hidden_piles[i].extend(hidden);
        piles[i].extend(visible);
    }

    let waste = parse_cards(&req.waste, "waste")?;
    let stock = parse_cards(&req.stock, "stock")?;
    if waste.len() + stock.len() > usize::from(N_DECK_CARDS) {
        return Err(format!(
            "stock + waste hold {} cards (max {N_DECK_CARDS})",
            waste.len() + stock.len()
        ));
    }
    all_cards.extend(&waste);
    all_cards.extend(&stock);

    // Exactly the full 52-card set, each card exactly once.
    let mut used = 0u64;
    for card in &all_cards {
        let bit = 1u64 << app_card_index(*card);
        if used & bit != 0 {
            return Err(format!("duplicate card {}", format_app_card(*card)));
        }
        used |= bit;
    }
    if all_cards.len() != 52 {
        return Err(format!("expected 52 cards total, got {}", all_cards.len()));
    }

    // Physical deck layout: waste bottom→top as-is, then the stock reversed
    // (app: last element drawn next; lonelybot: first stock slot drawn next).
    let mut deck_cards = waste.clone();
    deck_cards.extend(stock.iter().rev());
    #[allow(clippy::cast_possible_truncation)]
    let draw_cur = waste.len() as u8;

    // Stack::from_counts takes lonelybot suit order 0=♥ 1=♦ 2=♣ 3=♠.
    let stack = Stack::from_counts([f.h, f.d, f.c, f.s]);
    let draw_step = NonZeroU8::new(req.draw_count).expect("validated above");

    Ok(StandardSolitaire::from_midgame(
        hidden_piles,
        piles,
        &deck_cards,
        draw_cur,
        stack,
        draw_step,
    ))
}

/// Board-first hint (F9, user-approved "Option 1"): no-draw progress moves
/// available RIGHT NOW at `game`'s position, in the deterministic preference
/// order the hint should use. Each still needs a winnability-verifying
/// sub-solve before it may be hinted.
///
/// Uses `gen_moves::<false>` on purpose: the default dominance generation
/// (`<true>`) collapses the mask to a single forced move whenever any
/// provably-safe move exists (e.g. a buried ace reachable in the deck), which
/// would empty this candidate list exactly when it matters most (see plan doc
/// "Solver-side line-quality feasibility", state.rs:136-206).
///
/// Included, in order:
///   a. `PileStack`  — tableau→foundation (a covered card expands to a
///      pile→pile pre-move via `convert_move`, still a no-draw board move);
///   b. `DeckStack`  — waste-top→foundation, only when the card IS the
///      current waste top (anything else implies draws first);
///   c. `Reveal`     — tableau→tableau run move (incl. the king-to-empty
///      variants lonelybot models);
///   d. `DeckPile`   — waste-top→tableau, same waste-top-only filter.
/// Excluded: `StackPile` (foundation→tableau dig — never a "nice flow" hint;
/// the main-line fallback still covers it when it's the only way) and deck
/// moves whose card is not the current waste top.
fn board_first_candidates(game: &Solitaire) -> Vec<Move> {
    let waste_top = game.get_deck().peek_current();
    let moves = game.gen_moves::<false>().to_vec::<N_MOVES_MAX>();

    let mut ordered = Vec::with_capacity(moves.len());
    ordered.extend(moves.iter().filter(|m| matches!(m, Move::PileStack(_))));
    ordered.extend(
        moves
            .iter()
            .filter(|m| matches!(m, Move::DeckStack(c) if Some(*c) == waste_top)),
    );
    ordered.extend(moves.iter().filter(|m| matches!(m, Move::Reveal(_))));
    ordered.extend(
        moves
            .iter()
            .filter(|m| matches!(m, Move::DeckPile(c) if Some(*c) == waste_top)),
    );
    ordered
}

/// Given a solved main line, pick the board-first move to hint instead of the
/// line's first move: the first candidate (in `board_first_candidates` order)
/// whose one-move-deeper position is verified still winnable within a budget
/// slice. Returns `None` when no candidate verifies (hint falls back to the
/// main line's first move, typically a draw).
///
/// Runs on the solve thread. `stats` is the request-wide visit counter, so
/// `visited` in the response sums the main solve AND all verification
/// sub-solves (documented in the plan doc; matches `solveMs` covering the
/// total request time). A `Terminated` sub-solve counts as not-verified and
/// moves on — a slow candidate must never block the hint.
fn pick_board_first_move(
    game: &Solitaire,
    main_line: &HistoryVec,
    deadline: Option<Instant>,
    stats: &impl SearchStatistics,
) -> Option<Move> {
    let first_main = *main_line.first()?;

    for candidate in board_first_candidates(game) {
        // The main line itself proves this candidate keeps the game winnable
        // — no sub-solve needed (also immune to a spurious budget timeout).
        if candidate == first_main {
            return Some(candidate);
        }

        let remaining = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        if remaining.is_some_and(|r| r.is_zero()) {
            // Request budget exhausted: fall back to the main-line hint
            // rather than firing doomed zero-budget sub-solves.
            return None;
        }
        let slice = remaining.map_or(Duration::from_millis(CANDIDATE_SLICE_MS), |r| {
            (r / 2).min(Duration::from_millis(CANDIDATE_SLICE_MS))
        });

        // SolitaireEngine is the sanctioned public way to apply one primitive
        // move (Solitaire::do_move is pub(crate)); it validates against the
        // same gen_moves mask the candidate came from, so this never fails.
        let mut engine = SolitaireEngine::<NoPruner>::new(game.clone());
        if !engine.do_move(candidate) {
            debug_assert!(false, "generated candidate must be applicable");
            continue;
        }
        let mut sub_game = engine.into_state();

        let sub_signal = DeadlineSignal {
            cancelled: AtomicBool::new(false),
            deadline: Instant::now().checked_add(slice),
        };
        let (sub_result, _) = solve_with_tracking(&mut sub_game, stats, &sub_signal);
        if sub_result == SearchResult::Solved {
            return Some(candidate);
        }
        // Unsolvable → the candidate genuinely loses the game; Terminated →
        // unverified within the slice. Either way: try the next one.
    }
    None
}

/// Derive the app-facing hint from the winning line. `convert_moves` expands
/// the primitive moves into standard moves (n× DRAW_NEXT + a play); the FIRST
/// standard move is what the user should do next.
fn derive_hint(mut std_game: StandardSolitaire, history: &[Move]) -> Option<Hint> {
    let standard_moves = convert_moves(&mut std_game, history).ok()?;
    let first = standard_moves.first()?;

    if *first == StandardMove::DRAW_NEXT {
        // One hint = one stock tap, even if several draws precede the play.
        // A tap on an empty stock recycles the waste — also covered by "draw".
        return Some(Hint::Draw);
    }

    let from = match first.from {
        // A non-DRAW_NEXT move from Deck plays the current waste top card.
        Pos::Deck => HintFrom::Waste,
        Pos::Pile(i) => HintFrom::Tableau { index: i },
        Pos::Stack(lb_suit) => HintFrom::Foundation {
            suit: APP_SUIT_LETTERS[usize::from(SUIT_REMAP[usize::from(lb_suit)])],
        },
    };
    let to = match first.to {
        Pos::Pile(i) => HintTo::Tableau { index: i },
        Pos::Stack(_) => HintTo::Foundation,
        // Only DRAW_NEXT targets Deck and that is handled above.
        Pos::Deck => return None,
    };

    Some(Hint::Move {
        card: format_app_card(first.card),
        from,
        to,
    })
}

pub fn solve_request(req: &Request) -> Response {
    let std_game = match build_state(req) {
        Ok(g) => g,
        Err(msg) => return Response::invalid(msg),
    };

    let game = Solitaire::from(&std_game);
    if !game.is_valid() {
        // Defense in depth — build_state should already reject anything that
        // would trip the solver's internal invariants.
        return Response::invalid("state failed solver invariants");
    }

    let budget_ms = req.budget_ms.unwrap_or(DEFAULT_BUDGET_MS);
    let stats = Arc::new(VisitCounter(AtomicU64::new(0)));
    let signal = Arc::new(DeadlineSignal {
        cancelled: AtomicBool::new(false),
        // checked_add: an absurd budgetMs must not panic, it means "no deadline".
        deadline: Instant::now().checked_add(Duration::from_millis(budget_ms)),
    });

    let started = Instant::now();
    let joined = {
        let stats = Arc::clone(&stats);
        let signal = Arc::clone(&signal);
        let mut game = game;
        // Main solve + F9 board-first candidate verification both run on this
        // one 4 MiB-stack thread (the sub-solves recurse just as deeply).
        let spawned = std::thread::Builder::new()
            .stack_size(SOLVE_STACK_SIZE)
            .spawn(move || {
                let (result, history) =
                    solve_with_tracking(&mut game, stats.as_ref(), signal.as_ref());
                // solve_with_tracking restores `game`, so the candidate
                // search below sees the original request position.
                let board_first = match (&result, &history) {
                    (SearchResult::Solved, Some(line)) if !line.is_empty() => {
                        pick_board_first_move(&game, line, signal.deadline, stats.as_ref())
                    }
                    _ => None,
                };
                (result, history, board_first)
            });
        match spawned {
            Ok(handle) => handle.join(),
            Err(e) => return Response::error(format!("failed to spawn solve thread: {e}")),
        }
    };
    // Total request time including candidate verification (documented choice;
    // `visited` likewise sums main + verification solves).
    let solve_ms = started.elapsed().as_secs_f64() * 1000.0;

    let (result, history, board_first) = match joined {
        Ok(r) => r,
        Err(_) => return Response::error("solver thread panicked"),
    };
    let visited = stats.0.load(Ordering::Relaxed);

    let status = match result {
        SearchResult::Solved => Status::Solved,
        SearchResult::Unsolvable => Status::Unsolvable,
        SearchResult::Terminated => Status::Unknown,
        SearchResult::Crashed => return Response::error("solver crashed"),
    };

    let mut response = Response {
        status,
        message: None,
        solve_ms: Some(solve_ms),
        visited: Some(visited),
        win_moves_remaining: None,
        hint: None,
    };

    if status == Status::Solved {
        let history = history.unwrap_or_default();
        // Deliberately the MAIN line's primitive length even when a board-
        // first candidate is hinted (the candidate's own optimal line length
        // is unknown — its sub-solve only proves winnability).
        response.win_moves_remaining = Some(history.len());
        if history.is_empty() {
            // The position is already won — nothing to hint.
        } else {
            // Board-first hint (F9): prefer the verified no-draw candidate;
            // fall back to the main line's first move (typically a draw).
            // The candidate path clones std_game because derive_hint consumes
            // it replaying via convert_moves; the or_else fallback also
            // covers a (never observed) convert failure on the candidate.
            response.hint = board_first
                .and_then(|m| derive_hint(std_game.clone(), &[m]))
                .or_else(|| derive_hint(std_game, &history));
            if response.hint.is_none() {
                // Should be unreachable for a line the solver just proved.
                response.message = Some("solved but hint derivation failed".to_string());
            }
        }
    }

    response
}

pub fn solve_request_json(request_json: &str) -> String {
    let response = match serde_json::from_str::<Request>(request_json) {
        Ok(req) => solve_request(&req),
        Err(e) => Response::invalid(format!("bad request JSON: {e}")),
    };
    serde_json::to_string(&response).unwrap_or_else(|_| {
        r#"{"status":"error","message":"response serialization failed"}"#.to_string()
    })
}
