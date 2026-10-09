import { defineConfig } from 'vitest/config'

// npm run bench: the IPC benchmarks (tests/bench), one file at a time so they do not compete for the CPU. They are
// not part of npm run check; scripts/check-bench.mjs compares their results with tests/bench/floors.json.
export default defineConfig({
  test: {
    include: ['tests/bench/**/*.bench.ts'], globalSetup: ['tests/bench/setup.ts'], fileParallelism: false,
    testTimeout: 300_000, hookTimeout: 120_000
  }
})
