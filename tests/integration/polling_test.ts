// Integration test for the polling service

import { assertEquals, assertExists } from "@std/assert";
import { MockFeedServer, generateMockRssFeed } from "../mocks/mock_feed.ts";
import {
  getTestDatabase,
  resetTestDatabase,
  closeTestDatabase,
} from "../utils/test_database.ts";
import { PollingService } from "../../services/polling.ts";
import { testConfig } from "../test_config.ts";

// Override the config with test config
import { config } from "../../config.ts";
Object.assign(config, testConfig);

Deno.test({
  name: "Polling Service - Poll RSS Feed",
  async fn() {
    // Reset the database
    await resetTestDatabase();
    const db = await getTestDatabase();

    // Start a mock feed server
    const mockServer = new MockFeedServer(8081);
    const feedPath = "/test-feed.xml";
    const feedUrl = `http://localhost:8081${feedPath}`;

    // Create a mock RSS feed
    const rssFeed = generateMockRssFeed({
      title: "Test RSS Feed",
      link: feedUrl,
      items: 3,
    });

    mockServer.addFeed(feedPath, rssFeed);
    await mockServer.start();

    try {
      // Create a feed in the database
      const feed = await db.feeds.create({
        url: feedUrl,
        title: "Test Feed",
        pollingInterval: 5, // 5 minutes
        active: true,
        supportsWebSub: false,
      });

      // Poll the feed
      const result = await PollingService.pollFeed(feed);

      // Verify the result
      assertEquals(result.success, true);
      assertEquals(result.newItems, 3);

      // Verify the feed was updated
      const updatedFeed = await db.feeds.getById(feed.id);
      assertExists(updatedFeed); // Ensure feed exists
      if (updatedFeed) {
        assertEquals(updatedFeed.title, "Test RSS Feed"); // Title should be updated from the feed
        assertExists(updatedFeed.lastFetched);
        assertExists(updatedFeed.lastUpdated);
        assertExists(updatedFeed.etag);
        assertExists(updatedFeed.lastModified);
      }

      // Verify the items were created
      const items = await db.feeds.getItemsByFeed(feed.id);
      assertEquals(items.length, 3);

      // Update the feed with new content
      const updatedRssFeed = generateMockRssFeed({
        title: "Updated Test RSS Feed",
        link: feedUrl,
        items: 5, // Add 2 new items
      });

      mockServer.updateFeed(feedPath, updatedRssFeed);

      // Poll the feed again
      if (updatedFeed) {
        const secondResult = await PollingService.pollFeed(updatedFeed);

        // Verify the result
        assertEquals(secondResult.success, true);
        assertEquals(secondResult.newItems, 2); // Should only find 2 new items

        // Verify the feed was updated
        const finalFeed = await db.feeds.getById(feed.id);
        assertExists(finalFeed);
        if (finalFeed) {
          assertEquals(finalFeed.title, "Updated Test RSS Feed"); // Title should be updated
        }

        // Verify all items were created
        const allItems = await db.feeds.getItemsByFeed(feed.id);
        assertEquals(allItems.length, 5);
      }
    } finally {
      // Clean up
      await mockServer.stop();
      await closeTestDatabase(db);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Polling Service - Conditional GET",
  async fn() {
    // Reset the database
    await resetTestDatabase();
    const db = await getTestDatabase();

    // Start a mock feed server
    const mockServer = new MockFeedServer(8082);
    const feedPath = "/conditional-feed.xml";
    const feedUrl = `http://localhost:8082${feedPath}`;

    // Create a mock RSS feed
    const rssFeed = generateMockRssFeed({
      title: "Conditional GET Test",
      link: feedUrl,
      items: 2,
    });

    mockServer.addFeed(feedPath, rssFeed);
    await mockServer.start();

    try {
      // Create a feed in the database
      const feed = await db.feeds.create({
        url: feedUrl,
        title: "Conditional Feed",
        pollingInterval: 5, // 5 minutes
        active: true,
        supportsWebSub: false,
      });

      // Poll the feed to get ETag and Last-Modified
      const result = await PollingService.pollFeed(feed);
      assertEquals(result.success, true);
      assertEquals(result.newItems, 2);

      // Get the updated feed with ETag and Last-Modified
      const updatedFeed = await db.feeds.getById(feed.id);
      assertExists(updatedFeed);

      if (updatedFeed) {
        assertExists(updatedFeed.etag);
        assertExists(updatedFeed.lastModified);

        // Poll again without changing the feed - should get 304 Not Modified
        const secondResult = await PollingService.pollFeed(updatedFeed);
        assertEquals(secondResult.success, true);
        assertEquals(secondResult.message, "Feed not modified");
        assertEquals(secondResult.newItems, 0);
      }
    } finally {
      // Clean up
      await mockServer.stop();
      await closeTestDatabase(db);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
