// JS entry of the soli-solver local Expo module (autolinked from modules/).
// The native side is a thin bridge over the Rust solver in rust/soli-solver-ffi;
// request/response JSON contract:
// docs/product/hints/hints-and-unwinnable-warning.md, section "FFI contract".
// Typed request building/response parsing lives in src/solitaire/solverBridge.ts
// (pure TS) so jest tests never touch this file.

type SoliSolverNativeModule = {
  solvePosition(requestJson: string): Promise<string>
}

let nativeModule: SoliSolverNativeModule | null = null

// requireNativeModule is resolved lazily INSIDE the function so importing this
// file never touches native module initialization (keeps jest and any
// type-only imports safe without mocks).
export function solvePosition(requestJson: string): Promise<string> {
  if (!nativeModule) {
    const { requireNativeModule } =
      require('expo-modules-core') as typeof import('expo-modules-core')
    nativeModule = requireNativeModule<SoliSolverNativeModule>('SoliSolver')
  }
  return nativeModule.solvePosition(requestJson)
}
