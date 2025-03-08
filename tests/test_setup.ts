// Test setup for SuperDuperFeeder

import { testConfig } from "./test_config.ts";

// Override the config with test config
import { config } from "../config.ts";

// Apply test configuration
export function setupTestEnvironment() {
  // Override the config with test config
  Object.assign(config, testConfig);

  console.log("Test environment set up with configuration:");
  console.log(`- Port: ${testConfig.port}`);
  console.log(`- Environment: ${testConfig.environment}`);
  console.log(`- KV Path: ${testConfig.kvPath || "default"}`);
}

// Set up the test environment when this module is imported
setupTestEnvironment();
