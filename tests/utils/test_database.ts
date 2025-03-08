// Test database utilities

import { testConfig } from "../test_config.ts";
import { getDatabase } from "../../utils/database.ts";
import type { Database } from "../../utils/database.ts";

// Initialize test data
async function initTestData(db: Database): Promise<void> {
  // Initialize the admin user
  await db.users.initAdminUser(testConfig.admin.username, "test-password");

  // Add any other test data initialization here
}

// Reset the test database
export async function resetTestDatabase(): Promise<void> {
  const db = await getDatabase();

  // We can't directly access the KV store to clear it since it's private
  // Instead, we'll delete all known data through the store interfaces

  // Delete all feeds and feed items
  const feeds = await db.feeds.getAll();
  for (const feed of feeds) {
    await db.feeds.delete(feed.id);
  }

  // Delete all webhooks
  const webhooks = await db.webhooks.getAll();
  for (const webhook of webhooks) {
    await db.webhooks.delete(webhook.id);
  }

  // Delete the admin user if it exists
  const adminUser = await db.users.getByUsername(testConfig.admin.username);
  if (adminUser) {
    await db.users.delete(adminUser.id);
  }

  // Re-initialize test data
  await initTestData(db);
}

// Get the test database instance
export async function getTestDatabase(): Promise<Database> {
  const db = await getDatabase();

  // Initialize test data if needed
  // We'll check if the admin user exists to determine if we need to initialize
  const adminUser = await db.users.getByUsername(testConfig.admin.username);
  if (!adminUser) {
    await initTestData(db);
  }

  return db;
}

// Close the database connection
export async function closeTestDatabase(db: Database): Promise<void> {
  // The Database class has a close method, but it's private
  // We need to use a workaround to close the connection
  try {
    // @ts-ignore - Accessing private method
    await db.close();
  } catch (error) {
    console.error("Error closing database:", error);
  }
}
