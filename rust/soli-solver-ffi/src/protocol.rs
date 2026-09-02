//! Request/response types + card-string codec for the FFI contract defined in
//! docs/product/hints/hints-and-unwinnable-warning.md ("FFI contract" section).
//! That doc is the single source of truth; keep this file and the Phase-B TS
//! types in sync with it.

use serde::{Deserialize, Serialize};

use lonelybot::card::{Card, N_RANKS};

/// App suit order is clubs, diamonds, hearts, spades (CDHS); lonelybot's
/// internal order is hearts, diamonds, clubs, spades (HDCS). The remap lives
/// here in Rust (mirroring lonecli's harvest-v2 `app_card_index`) so the TS
/// side never needs to know lonelybot's conventions. [2,1,0,3] is self-inverse,
/// so the same table converts in both directions.
pub const SUIT_REMAP: [u8; 4] = [2, 1, 0, 3];
pub const APP_SUIT_LETTERS: [char; 4] = ['c', 'd', 'h', 's'];

/// Parse an app card string like `"c1"` (A♣) or `"s13"` (K♠) into a lonelybot
/// `Card` (rank 0-based, lonelybot suit order).
pub fn parse_app_card(s: &str) -> Result<Card, String> {
    let mut chars = s.chars();
    let suit_letter = chars
        .next()
        .ok_or_else(|| "empty card string".to_string())?;
    let app_suit = APP_SUIT_LETTERS
        .iter()
        .position(|c| *c == suit_letter)
        .ok_or_else(|| format!("bad suit letter in card '{s}'"))? as u8;
    let rank: u8 = chars
        .as_str()
        .parse()
        .map_err(|_| format!("bad rank in card '{s}'"))?;
    if !(1..=N_RANKS).contains(&rank) {
        return Err(format!("rank out of range in card '{s}'"));
    }
    Ok(Card::new(rank - 1, SUIT_REMAP[app_suit as usize]))
}

/// Format a lonelybot `Card` as an app card string.
pub fn format_app_card(card: Card) -> String {
    let (rank, lb_suit) = card.split();
    let app_suit = SUIT_REMAP[lb_suit as usize];
    format!("{}{}", APP_SUIT_LETTERS[app_suit as usize], rank + 1)
}

/// 0..52 index in app order (suit-major) — only used for duplicate detection.
pub fn app_card_index(card: Card) -> u8 {
    let (rank, lb_suit) = card.split();
    SUIT_REMAP[lb_suit as usize] * N_RANKS + rank
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub draw_count: u8,
    /// Solve budget in ms; default 1500 when absent.
    pub budget_ms: Option<u64>,
    pub foundations: Foundations,
    pub tableau: Vec<TableauColumn>,
    /// App order: LAST element is drawn next (the app pops from the end).
    pub stock: Vec<String>,
    /// App order: LAST element is the top/playable card.
    pub waste: Vec<String>,
}

/// Number of cards already placed per foundation (2 = A,2 placed).
#[derive(Debug, Deserialize)]
pub struct Foundations {
    pub c: u8,
    pub d: u8,
    pub h: u8,
    pub s: u8,
}

#[derive(Debug, Deserialize)]
pub struct TableauColumn {
    /// Face-down cards, bottom→top (last = revealed next).
    pub hidden: Vec<String>,
    /// Face-up run, bottom→top (`visible[0]` sits on `hidden[last]`).
    pub visible: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solve_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visited: Option<u64>,
    /// Primitive (lonelybot) move count of the found winning line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub win_moves_remaining: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<Hint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Solved,
    Unsolvable,
    /// Budget exhausted before a proof either way.
    Unknown,
    /// Request failed validation (see `message`).
    Invalid,
    /// Internal error/panic (see `message`).
    Error,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Hint {
    /// Tap the stock once (even if several draws are needed before the play).
    Draw,
    Move {
        card: String,
        from: HintFrom,
        to: HintTo,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum HintFrom {
    Tableau {
        index: u8,
    },
    /// Play the current top card of the waste.
    Waste,
    Foundation {
        suit: char,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum HintTo {
    Tableau {
        index: u8,
    },
    /// Target foundation is implied by the card's suit.
    Foundation,
}

impl Response {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: Status::Invalid,
            message: Some(message.into()),
            solve_ms: None,
            visited: None,
            win_moves_remaining: None,
            hint: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            status: Status::Error,
            message: Some(message.into()),
            solve_ms: None,
            visited: None,
            win_moves_remaining: None,
            hint: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_round_trip_all_52() {
        for suit in APP_SUIT_LETTERS {
            for rank in 1..=13 {
                let s = format!("{suit}{rank}");
                let card = parse_app_card(&s).unwrap();
                assert_eq!(format_app_card(card), s);
            }
        }
    }

    #[test]
    fn remap_matches_known_cards() {
        // App clubs=0 → lonelybot suit 2; ranks are 1-based in the app.
        assert_eq!(parse_app_card("c1").unwrap(), Card::new(0, 2));
        assert_eq!(parse_app_card("d5").unwrap(), Card::new(4, 1));
        assert_eq!(parse_app_card("h13").unwrap(), Card::new(12, 0));
        assert_eq!(parse_app_card("s13").unwrap(), Card::new(12, 3));
    }

    #[test]
    fn rejects_bad_cards() {
        for bad in ["", "x1", "c0", "c14", "cc", "1c"] {
            assert!(parse_app_card(bad).is_err(), "{bad} should be rejected");
        }
    }
}
