import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    env: {
      // Production defaults to closed signup (sign-in only for provisioned
      // accounts). Tests mint users via the magic-link dance, so run them open;
      // closed-signup behavior is covered explicitly in closed-signup.test.ts.
      SIGNUP_MODE: 'open',
      // No mailer in tests: sign-in codes come back in the response (never
      // set this on a reachable server — see inlineCodesAllowed in mfa.ts).
      POMEGRANATE_DEV_INLINE_CODES: '1',
      // Tests send X-Forwarded-For as if from one reverse proxy.
      POMEGRANATE_TRUSTED_PROXY_HOPS: '1',
    },
  },
});
