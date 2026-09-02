//! JNI-named export for the Android Expo module (Phase B).
//!
//! Kotlin cannot call a plain C ABI directly, so alongside `soli_solver_solve`
//! we export one JNI function. The symbol name encodes the Kotlin side and
//! must match it EXACTLY: object `SoliSolverJni` in package
//! `expo.modules.solisolver` declaring `external fun nativeSolve(String): String`
//! (see modules/soli-solver/android/.../SoliSolverModule.kt).
//!
//! Wraps the safe `solve_request_json` (NOT the raw C functions) so there is no
//! manual CString ownership here; JNI strings are copied in/out. Panics degrade
//! to a `{"status":"error"}` response, same guarantee as the C boundary.

use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use std::panic::catch_unwind;

use crate::solve_request_json;

#[no_mangle]
pub extern "system" fn Java_expo_modules_solisolver_SoliSolverJni_nativeSolve<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    request: JString<'local>,
) -> jstring {
    let request: Result<String, _> = env.get_string(&request).map(Into::into);
    let response = match request {
        Ok(request) => catch_unwind(|| solve_request_json(&request))
            .unwrap_or_else(|_| r#"{"status":"error","message":"solver panicked"}"#.to_string()),
        Err(_) => r#"{"status":"error","message":"failed to read request string"}"#.to_string(),
    };

    // A JVM allocation failure here leaves a pending Java exception; returning
    // null is then the correct JNI convention.
    env.new_string(response)
        .map_or(std::ptr::null_mut(), JString::into_raw)
}
