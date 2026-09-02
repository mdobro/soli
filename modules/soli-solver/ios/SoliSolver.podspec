Pod::Spec.new do |s|
  s.name           = 'SoliSolver'
  s.version        = '0.1.0'
  s.summary        = 'Rust Klondike solver bridge for Soli'
  s.description    = 'Local Expo module exposing the bundled Rust (lonelybot) solver.'
  s.license        = 'MIT'
  s.author         = ''
  s.homepage       = 'https://github.com/karimattia/soli'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Rust static lib + header, built by scripts/build-rust-solver.sh into this
  # directory (device + simulator slices).
  s.vendored_frameworks = 'SoliSolver.xcframework'

  # Top-level files only, so this never matches the xcframework's internals.
  s.source_files = '*.{h,m,swift}'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
