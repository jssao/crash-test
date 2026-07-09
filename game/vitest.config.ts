import { defineConfig } from 'vitest/config';

// Headless drive-test suite (G2 spec). Physics runs in plain node (no jsdom/browser needed) via the
// box3d-js binding + game/src/vehicle's renderer-free physics core -- see game/sim/harness.mjs.
export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ['sim/**/*.test.mjs'],
  },
});
