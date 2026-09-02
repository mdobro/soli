//! Test/perf-only mirror of the APP's game-state semantics: stock pops from
//! the END of the array, waste top is the END, recycling flips the waste back
//! into the stock. The integration tests and the perf example use it to drive
//! the solver along winning lines exactly like the app would. NOT part of the
//! FFI surface — the real app keeps its own state in TypeScript.

use lonelybot::card::Card;
use lonelybot::deck::{N_PILES, N_PILE_CARDS};
use lonelybot::shuffler::CardDeck;
use lonelybot::standard::{Pos, StandardMove};

use crate::protocol::{format_app_card, SUIT_REMAP};

#[derive(Clone)]
pub struct AppState {
    pub draw_count: u8,
    /// App suit order c, d, h, s — number of cards on each foundation.
    pub foundations: [u8; 4],
    /// Per column: (hidden, visible), both bottom→top.
    pub tableau: Vec<(Vec<Card>, Vec<Card>)>,
    /// Last element = drawn next.
    pub stock: Vec<Card>,
    /// Last element = top/playable.
    pub waste: Vec<Card>,
}

impl AppState {
    /// Fresh deal from a lonelybot 52-card shuffle (triangle layout: column i
    /// gets i face-down cards + 1 face-up; the rest is the stock in draw
    /// order, which the app stores reversed because it pops from the end).
    pub fn from_fresh_deal(cards: &CardDeck, draw_count: u8) -> Self {
        let mut tableau = Vec::with_capacity(usize::from(N_PILES));
        for i in 0..usize::from(N_PILES) {
            let start = i * (i + 1) / 2;
            let hidden = cards[start..start + i].to_vec();
            let visible = vec![cards[start + i]];
            tableau.push((hidden, visible));
        }
        let stock = cards[usize::from(N_PILE_CARDS)..]
            .iter()
            .rev()
            .copied()
            .collect();
        Self {
            draw_count,
            foundations: [0; 4],
            tableau,
            stock,
            waste: Vec::new(),
        }
    }

    pub fn app_suit(card: Card) -> usize {
        usize::from(SUIT_REMAP[usize::from(card.suit())])
    }

    pub fn is_won(&self) -> bool {
        self.foundations.iter().all(|c| *c == 13)
    }

    pub fn to_request_json(&self, budget_ms: u64) -> String {
        let cards =
            |list: &[Card]| -> Vec<String> { list.iter().copied().map(format_app_card).collect() };
        serde_json::json!({
            "drawCount": self.draw_count,
            "budgetMs": budget_ms,
            "foundations": {
                "c": self.foundations[0],
                "d": self.foundations[1],
                "h": self.foundations[2],
                "s": self.foundations[3],
            },
            "tableau": self.tableau.iter().map(|(hidden, visible)| serde_json::json!({
                "hidden": cards(hidden),
                "visible": cards(visible),
            })).collect::<Vec<_>>(),
            "stock": cards(&self.stock),
            "waste": cards(&self.waste),
        })
        .to_string()
    }

    /// Apply one lonelybot `StandardMove` using the app's move semantics.
    /// Panics if the move is illegal in this state (tests rely on that).
    pub fn apply(&mut self, m: &StandardMove) {
        if *m == StandardMove::DRAW_NEXT {
            if self.stock.is_empty() {
                // Recycle only — the next draw is a separate DRAW_NEXT, same
                // as lonelybot's deal_once at end-of-deck and the app's
                // tap-on-empty-stock.
                self.stock = self.waste.drain(..).rev().collect();
            } else {
                for _ in 0..usize::from(self.draw_count).min(self.stock.len()) {
                    let card = self.stock.pop().unwrap();
                    self.waste.push(card);
                }
            }
            return;
        }

        match (m.from, m.to) {
            (Pos::Deck, Pos::Pile(to)) => {
                let card = self.waste.pop().unwrap();
                assert_eq!(card, m.card, "waste top mismatch");
                self.tableau[usize::from(to)].1.push(card);
            }
            (Pos::Deck, Pos::Stack(_)) => {
                let card = self.waste.pop().unwrap();
                assert_eq!(card, m.card, "waste top mismatch");
                self.foundations[Self::app_suit(card)] += 1;
            }
            (Pos::Pile(from), Pos::Pile(to)) => {
                let visible = &mut self.tableau[usize::from(from)].1;
                let pos = visible
                    .iter()
                    .position(|c| *c == m.card)
                    .expect("moved card must be in the source run");
                let moved: Vec<Card> = visible.drain(pos..).collect();
                self.tableau[usize::from(to)].1.extend(moved);
                self.flip(usize::from(from));
            }
            (Pos::Pile(from), Pos::Stack(_)) => {
                let card = self.tableau[usize::from(from)].1.pop().unwrap();
                assert_eq!(card, m.card, "pile top mismatch");
                self.foundations[Self::app_suit(card)] += 1;
                self.flip(usize::from(from));
            }
            (Pos::Stack(_), Pos::Pile(to)) => {
                let suit = Self::app_suit(m.card);
                assert_eq!(self.foundations[suit], m.card.rank() + 1);
                self.foundations[suit] -= 1;
                self.tableau[usize::from(to)].1.push(m.card);
            }
            other => panic!("unexpected standard move {other:?}"),
        }
    }

    fn flip(&mut self, i: usize) {
        let (hidden, visible) = &mut self.tableau[i];
        if visible.is_empty() {
            if let Some(card) = hidden.pop() {
                visible.push(card);
            }
        }
    }
}
