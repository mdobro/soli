// Official jest mock for react-native-worklets (reanimated 4's engine), per
// https://docs.swmansion.com/react-native-worklets/docs/guides/testing/ —
// without it, ANY unit test that (transitively) imports react-native-reanimated
// crashes at import time: worklets instantiates its native TurboModule proxy at
// module scope (`loadUnpackers`), which doesn't exist under jest. First needed
// for hintOverlay.test.ts (imports klondike constants → reanimated Easing).
// The web-implementation alternative (resolver: 'react-native-worklets/jest/
// resolver') is not an option here — the resolver slot is taken by
// jest-pnp-resolver.
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'))
