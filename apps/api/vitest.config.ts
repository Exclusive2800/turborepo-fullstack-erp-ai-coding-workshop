import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    // The first Nest testing-module compile in each file can exceed the 5s default
    // on a cold machine (SWC transform of the module graph). Give it headroom.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
