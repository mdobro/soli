//! C-ABI JSON bridge around the vendored lonelybot Klondike solver, for the
//! Soli app's hint + unwinnable-warning features.
//!
//! Contract (single source of truth):
//! docs/product/hints/hints-and-unwinnable-warning.md, section "FFI contract".
//! One request JSON in, one response JSON out; all suit/order conventions are
//! translated Rust-side so the TypeScript caller stays dumb.

#[cfg(target_os = "android")]
mod android_jni;
pub mod app_model;
pub mod protocol;
mod solve;

pub use solve::{solve_request, solve_request_json};

use std::ffi::{c_char, CStr, CString};
use std::panic::catch_unwind;

/// Solve the position described by `request_json` (UTF-8, NUL-terminated).
/// Returns a heap-allocated JSON response the caller MUST free with
/// [`soli_solver_free_string`]. Panics never unwind across this boundary —
/// they degrade to a `{"status":"error"}` response.
///
/// # Safety
/// `request_json` must be null or a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn soli_solver_solve(request_json: *const c_char) -> *mut c_char {
    let response = catch_unwind(|| {
        if request_json.is_null() {
            return r#"{"status":"error","message":"null request pointer"}"#.to_string();
        }
        // SAFETY: non-null checked above; validity is the caller's contract.
        match unsafe { CStr::from_ptr(request_json) }.to_str() {
            Ok(request) => solve_request_json(request),
            Err(_) => r#"{"status":"error","message":"request is not valid UTF-8"}"#.to_string(),
        }
    })
    .unwrap_or_else(|_| r#"{"status":"error","message":"solver panicked"}"#.to_string());

    // Our serializer never emits NUL bytes; null return is a pure safety net.
    CString::new(response).map_or(std::ptr::null_mut(), CString::into_raw)
}

/// Free a string returned by [`soli_solver_solve`]. Null is a safe no-op.
///
/// # Safety
/// `ptr` must be null or a pointer obtained from [`soli_solver_solve`], and
/// must not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn soli_solver_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        // SAFETY: per contract, `ptr` came from CString::into_raw above.
        drop(unsafe { CString::from_raw(ptr) });
    }
}
