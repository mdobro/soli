// C ABI for the Soli Klondike solver (rust/soli-solver-ffi).
// JSON request/response contract:
// docs/product/hints/hints-and-unwinnable-warning.md, section "FFI contract".

#ifndef SOLI_SOLVER_H
#define SOLI_SOLVER_H

#ifdef __cplusplus
extern "C" {
#endif

// Solves the position in `request_json` (UTF-8, NUL-terminated).
// Returns a heap-allocated NUL-terminated JSON response (never NULL in
// practice; NULL only on allocation failure). The caller MUST release it
// with soli_solver_free_string. Safe to call from any thread; the solve
// itself runs on an internal 4 MiB-stack thread bounded by budgetMs.
char *soli_solver_solve(const char *request_json);

// Frees a string returned by soli_solver_solve. NULL is a safe no-op.
void soli_solver_free_string(char *ptr);

#ifdef __cplusplus
}
#endif

#endif // SOLI_SOLVER_H
