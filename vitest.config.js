import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.toml' } })],
  test: { testTimeout: 90_000, hookTimeout: 90_000 },
});
