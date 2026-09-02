package expo.modules.solisolver

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// JNI bridge to the Rust solver (rust/soli-solver-ffi). Package + object +
// function name together form the exported JNI symbol and must stay in sync
// with rust/soli-solver-ffi/src/android_jni.rs:
//   Java_expo_modules_solisolver_SoliSolverJni_nativeSolve
object SoliSolverJni {
  init {
    // libsoli_solver_ffi.so from android/src/main/jniLibs/<abi>/ (built by
    // scripts/build-rust-solver.sh).
    System.loadLibrary("soli_solver_ffi")
  }

  external fun nativeSolve(request: String): String
}

class SoliSolverModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SoliSolver")

    // Coroutine bodies start on the shared expo.modules.AsyncFunctionQueue
    // HandlerThread; hop to Dispatchers.Default because a solve can block up
    // to its budget (~1.5 s, enforced inside Rust) and must not stall other
    // modules' async calls on that shared queue (see rust-mobile.md guide).
    AsyncFunction("solvePosition") Coroutine { requestJson: String ->
      withContext(Dispatchers.Default) { SoliSolverJni.nativeSolve(requestJson) }
    }
  }
}
