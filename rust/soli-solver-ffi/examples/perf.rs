//! Desktop perf harness for the Soli solver FFI (Phase A5 of
//! docs/product/hints/hints-and-unwinnable-warning.md).
//!
//! For each draw count in {1, 3, 5}:
//! - scan default seeds for solvable and unsolvable fresh deals,
//! - solve every fresh deal through the JSON API (what the app will call),
//! - walk each solvable deal's winning line with the app-semantics model and
//!   re-solve mid-game positions through the JSON API (every 5th position;
//!   every position for the first FULL_WALK_SEEDS seeds).
//!
//! Run: cargo run --release --example perf -p soli-solver-ffi

use std::num::NonZeroU8;
use std::time::Instant;

use serde_json::Value;

use lonelybot::convert::convert_moves;
use lonelybot::shuffler::default_shuffle;
use lonelybot::solver::{solve_with_tracking, HistoryVec, SearchResult};
use lonelybot::standard::StandardSolitaire;
use lonelybot::state::Solitaire;
use lonelybot::tracking::{EmptySearchStats, TerminateSignal};

use soli_solver_ffi::app_model::AppState;
use soli_solver_ffi::solve_request_json;

const SOLVABLE_TARGET: usize = 150;
const FULL_WALK_SEEDS: usize = 30;
const UNSOLVABLE_TARGET: usize = 50;
const SEED_SCAN_CAP: u64 = 3000;
const BUDGET_MS: u64 = 5000;

struct ScanDeadline(Instant);
impl TerminateSignal for ScanDeadline {
    fn is_terminated(&self) -> bool {
        Instant::now() >= self.0
    }
}

#[derive(Default)]
struct Samples {
    ms: Vec<f64>,
    visited: Vec<u64>,
}

impl Samples {
    fn push(&mut self, response: &Value) {
        self.ms.push(response["solveMs"].as_f64().unwrap());
        self.visited.push(response["visited"].as_u64().unwrap_or(0));
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx]
}

fn stats_row(label: &str, samples: &Samples) -> String {
    let mut ms = samples.ms.clone();
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut visited = samples
        .visited
        .iter()
        .map(|v| *v as f64)
        .collect::<Vec<_>>();
    visited.sort_by(|a, b| a.partial_cmp(b).unwrap());
    format!(
        "{label:<28} n={:<6} P50={:>8.3} P90={:>8.3} P99={:>8.3} max={:>9.3} | visited P50={:>7.0} P99={:>8.0} max={:>9.0}",
        ms.len(),
        percentile(&ms, 0.50),
        percentile(&ms, 0.90),
        percentile(&ms, 0.99),
        percentile(&ms, 1.0),
        percentile(&visited, 0.50),
        percentile(&visited, 0.99),
        percentile(&visited, 1.0),
    )
}

fn main() {
    println!("Soli solver perf harness — lonelybot via soli-solver-ffi JSON API");
    println!(
        "single-threaded solves on {} ({} logical cores available, release build, budget {BUDGET_MS} ms)",
        std::env::consts::ARCH,
        std::thread::available_parallelism().map_or(0, |n| n.get()),
    );
    let overall_start = Instant::now();

    for draw in [1u8, 3, 5] {
        let step = NonZeroU8::new(draw).unwrap();

        // Phase 1: classify fresh deals by direct (non-FFI) solve.
        let mut solvable: Vec<(u64, HistoryVec)> = Vec::new();
        let mut unsolvable_seeds: Vec<u64> = Vec::new();
        let mut scan_terminated = 0usize;
        for seed in 0..SEED_SCAN_CAP {
            if solvable.len() >= SOLVABLE_TARGET && unsolvable_seeds.len() >= UNSOLVABLE_TARGET {
                break;
            }
            let mut game = Solitaire::new(&default_shuffle(seed), step);
            let deadline =
                ScanDeadline(Instant::now() + std::time::Duration::from_millis(BUDGET_MS));
            let (result, history) = solve_with_tracking(&mut game, &EmptySearchStats {}, &deadline);
            match result {
                SearchResult::Solved => {
                    if solvable.len() < SOLVABLE_TARGET {
                        solvable.push((seed, history.unwrap()));
                    }
                }
                SearchResult::Unsolvable => {
                    if unsolvable_seeds.len() < UNSOLVABLE_TARGET {
                        unsolvable_seeds.push(seed);
                    }
                }
                _ => scan_terminated += 1,
            }
        }

        // Phase 2: fresh solves through the JSON API.
        let mut fresh_solved = Samples::default();
        let mut fresh_unsolvable = Samples::default();
        let mut fresh_unknown = 0usize;
        for (seed, _) in &solvable {
            let app = AppState::from_fresh_deal(&default_shuffle(*seed), draw);
            let response: Value =
                serde_json::from_str(&solve_request_json(&app.to_request_json(BUDGET_MS))).unwrap();
            match response["status"].as_str().unwrap() {
                "solved" => fresh_solved.push(&response),
                "unknown" => fresh_unknown += 1,
                other => panic!("fresh solvable seed {seed}: unexpected status {other}"),
            }
        }
        for seed in &unsolvable_seeds {
            let app = AppState::from_fresh_deal(&default_shuffle(*seed), draw);
            let response: Value =
                serde_json::from_str(&solve_request_json(&app.to_request_json(BUDGET_MS))).unwrap();
            match response["status"].as_str().unwrap() {
                "unsolvable" => fresh_unsolvable.push(&response),
                "unknown" => fresh_unknown += 1,
                other => panic!("fresh unsolvable seed {seed}: unexpected status {other}"),
            }
        }

        // Phase 3: mid-game re-solves along winning lines.
        let mut mid_solved = Samples::default();
        let mut mid_unsolvable = Samples::default();
        let mut mid_unknown = 0usize;
        let mut positions_walked = 0usize;
        for (seed_idx, (seed, history)) in solvable.iter().enumerate() {
            let cards = default_shuffle(*seed);
            let mut std_game = StandardSolitaire::new(&cards, step);
            let standard_moves = convert_moves(&mut std_game, history).unwrap();

            let mut app = AppState::from_fresh_deal(&cards, draw);
            let every_position = seed_idx < FULL_WALK_SEEDS;
            for (pos_idx, m) in standard_moves.iter().enumerate() {
                app.apply(m);
                if app.is_won() {
                    break;
                }
                if !every_position && pos_idx % 5 != 0 {
                    continue;
                }
                positions_walked += 1;
                let response: Value =
                    serde_json::from_str(&solve_request_json(&app.to_request_json(BUDGET_MS)))
                        .unwrap();
                match response["status"].as_str().unwrap() {
                    "solved" => mid_solved.push(&response),
                    // Cannot happen on a winning line; count defensively.
                    "unsolvable" => mid_unsolvable.push(&response),
                    "unknown" => mid_unknown += 1,
                    other => panic!("seed {seed} position {pos_idx}: status {other}"),
                }
            }
        }

        println!();
        println!(
            "=== draw {draw} — {} solvable + {} unsolvable fresh seeds (scan terminated: {scan_terminated}), {positions_walked} mid-game positions ===",
            solvable.len(),
            unsolvable_seeds.len(),
        );
        println!("{}", stats_row("fresh solved (ms)", &fresh_solved));
        println!("{}", stats_row("fresh unsolvable (ms)", &fresh_unsolvable));
        println!("{}", stats_row("mid-game solved (ms)", &mid_solved));
        if !mid_unsolvable.ms.is_empty() {
            println!("{}", stats_row("mid-game unsolvable (ms)", &mid_unsolvable));
        }
        println!(
            "unknown (budget {BUDGET_MS} ms hit): fresh={fresh_unknown} mid-game={mid_unknown}"
        );
    }

    println!();
    println!(
        "total harness time: {:.1}s",
        overall_start.elapsed().as_secs_f64()
    );
}
