import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        kvNamespaces: ["MODEL_CATALOG_CACHE"],
        bindings: {
          APP_MODE: "phase0-local",
          BUILD_ID: "phase0-test",
          PHASE0_GEMINI_MODEL: "model-phase0",
          PHASE0_OPENAI_MODEL: "model-phase0",
          PHASE0_ANTHROPIC_MODEL: "model-phase0",
          PHASE0_XAI_MODEL: "model-phase0",
          PHASE0_OPENROUTER_MODEL: "synthetic/model-phase0",
          PHASE0_VALIDATION_TOKEN: "phase0-test-token",
          OWNER_AUTH_TOKEN: "phase1-owner-test-token",
          BUNDLE_SIGNING_KEY: "phase1-signing-test-key",
          STANDBY_ENCRYPTION_KEY: "phase5-standby-encryption-test-key-0001",
          STANDBY_ENCRYPTION_KEY_ID: "standby-test-key-1",
          LITE_ALLOWED_ORIGIN: "https://lite.test",
          TRAVEL_GEMINI_MODEL: "model-phase1",
          GEMINI_PERSONAL_1: "phase0-gemini-test-secret",
          OPENAI_PERSONAL_1: "phase0-openai-test-secret",
          ANTHROPIC_PERSONAL_1: "phase0-anthropic-test-secret",
          XAI_PERSONAL_1: "phase0-xai-test-secret",
          OPENROUTER_PERSONAL_1: "phase0-openrouter-test-secret",
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.spec.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
