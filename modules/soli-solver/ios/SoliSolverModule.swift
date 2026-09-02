import ExpoModulesCore

// Declarations for the two C symbols exported by the vendored Rust static
// library (SoliSolver.xcframework). @_silgen_name instead of importing the
// bundled C header: a Swift-only CocoaPods pod has no bridging header, and
// exposing a vendored framework's header through a module map/umbrella is the
// fragile part of pod setups — a direct symbol reference cannot break at the
// header-search-path level. The signatures MUST stay in sync with
// rust/soli-solver-ffi/include/soli_solver.h (the contract reference).
@_silgen_name("soli_solver_solve")
private func soli_solver_solve(
  _ requestJson: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>?

@_silgen_name("soli_solver_free_string")
private func soli_solver_free_string(_ ptr: UnsafeMutablePointer<CChar>?)

public class SoliSolverModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SoliSolver")

    // Plain-closure AsyncFunction: runs on the shared serial
    // expo.modules.AsyncFunctionQueue, off the JS thread. Trade-off: a solve
    // blocks OTHER Expo modules' async functions on that shared queue for its
    // duration — accepted because the Rust side enforces the time budget
    // internally (~1.5 s worst case; see rust-mobile.md guide).
    AsyncFunction("solvePosition") { (requestJson: String) -> String in
      // The returned pointer is Rust-heap-allocated (independent of the
      // temporary C string), so it may escape withCString.
      guard let raw = requestJson.withCString({ soli_solver_solve($0) }) else {
        // Null only on allocation failure inside Rust (see header contract).
        return "{\"status\":\"error\",\"message\":\"solver returned null\"}"
      }
      defer { soli_solver_free_string(raw) }
      return String(cString: raw)
    }
  }
}
