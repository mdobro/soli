# Vendored: lonelybot (core crate)

- Upstream: <https://github.com/vuonghy2442/lonelybot>
- Revision: `ae30d391575e4dfdbf6d6bc434d99aeb9b752456` (upstream `main`; core lib verified unmodified in the local checkout at vendoring time)
- Vendored: 2026-07-13 from local checkout `/Users/karim/kDrive/Code/Lonelybot/lonelybot`
- License: MIT (see `LICENSE`)
- Copied: `src/` + `LICENSE`. Excluded: `lonecli/`, `python/`, `script/`, `benches/`, `tests/` (only an `#[ignore]`d cycle test), `target/`, `Cargo.lock`, `README.md`.

Why vendored: lonelybot has no public mid-game constructor (all state fields are
private, `Deck::set_offset` / `Hidden::from_piles` / `Stack` builders are
`pub(crate)`), and the Soli app needs to solve arbitrary mid-game positions for
hints + unwinnable detection. See
`docs/product/hints/hints-and-unwinnable-warning.md`.

## SOLI PATCH list

Every change in the vendored sources is marked with a `// SOLI PATCH: <why>`
comment. Current list:

1. `Cargo.toml` — rewritten as a standalone manifest: dropped upstream's
   workspace members (`lonecli`), bench target, criterion dev-dependency and
   local profiles (release profile lives in the `rust/` workspace root now).
   Dependencies and their feature flags are unchanged.
2. `src/deck.rs` — added pub `Deck::from_remaining(cards, draw_cur, draw_step)`:
   mid-game deck constructor (waste + stock as one physical list, current order
   declared canonical for the `mask`/`map` invariants).
3. `src/stack.rs` — added pub `Stack::from_counts([u8; 4])`: foundation counts
   in lonelybot suit order (H, D, C, S).
4. `src/standard.rs` — added pub `StandardSolitaire::from_midgame(...)`
   composing the above; derived `Clone` on `StandardSolitaire` (needed to
   replay the winning line through `convert_moves` for hint derivation).
5. `src/state.rs` — `Solitaire::is_valid()` made `pub` (was `pub(crate)`) so
   the FFI crate's tests can assert constructed mid-game states are internally
   consistent. No behavior change.

## Update procedure

1. `git -C <lonelybot checkout> pull`, note the new rev.
2. Re-copy `src/` + `LICENSE` over this directory.
3. Re-apply the patches (search this file and `rg 'SOLI PATCH' src/`).
4. Update the revision above and run `cargo test` in `rust/`.
