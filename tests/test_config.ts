// Test configuration

import { config as baseConfig } from "../config.ts";

export const testConfig = {
  ...baseConfig,
  // Override with test-specific settings
  port: 8001, // Use a different port for tests
  environment: "test",

  // Use a test-specific KV database
  kvPath: ":memory:", // Use in-memory KV for tests

  // Shorter intervals for faster testing
  defaultLeaseSeconds: 60, // 1 minute
  maxLeaseSeconds: 300, // 5 minutes
  defaultPollingIntervalMinutes: 1, // 1 minute
  minPollingIntervalMinutes: 1, // 1 minute

  // Firehose configuration for tests
  firehose: {
    ...baseConfig.firehose,
    webhookTimeout: 1000, // 1 second timeout for tests
    webhookRetries: 1, // Fewer retries for tests
  },
};
