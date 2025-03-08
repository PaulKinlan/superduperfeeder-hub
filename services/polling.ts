// RSS polling service

import { config } from "../config.ts";
import { getDatabase } from "../utils/database.ts";
import { Feed, FeedItem } from "../models/feed.ts";
import { parseFeed } from "../deps.ts";
import { HubService } from "./hub.ts";

// Class for handling RSS feed polling
export class PollingService {
  // Poll a feed for updates
  static async pollFeed(feed: Feed): Promise<{
    success: boolean;
    message: string;
    newItems: number;
  }> {
    try {
      const db = await getDatabase();

      // Skip inactive feeds
      if (!feed.active) {
        return {
          success: false,
          message: "Feed is inactive",
          newItems: 0,
        };
      }

      // Skip feeds that support WebSub (they'll notify us)
      if (feed.supportsWebSub) {
        return {
          success: false,
          message: "Feed supports WebSub, no need to poll",
          newItems: 0,
        };
      }

      // Prepare headers for conditional GET
      const headers: HeadersInit = {
        "User-Agent": `SuperDuperFeeder/${config.version}`,
      };

      if (feed.etag) {
        headers["If-None-Match"] = feed.etag;
      }

      if (feed.lastModified) {
        headers["If-Modified-Since"] = feed.lastModified;
      }

      // Fetch the feed
      const response = await fetch(feed.url, {
        method: "GET",
        headers,
      });

      // Update the last fetched time
      const now = new Date();
      feed.lastFetched = now;

      // Check if the feed has been modified
      if (response.status === 304) {
        // Not modified
        await db.feeds.update(feed);

        return {
          success: true,
          message: "Feed not modified",
          newItems: 0,
        };
      }

      // Check if the request was successful
      if (!response.ok) {
        // Update error count and last error
        feed.errorCount++;
        feed.lastError = `HTTP error: ${response.status} ${response.statusText}`;
        feed.lastErrorTime = now;

        await db.feeds.update(feed);

        return {
          success: false,
          message: feed.lastError,
          newItems: 0,
        };
      }

      // Reset error count
      feed.errorCount = 0;
      feed.lastError = undefined;
      feed.lastErrorTime = undefined;

      // Get the ETag and Last-Modified headers
      const etag = response.headers.get("ETag");
      const lastModified = response.headers.get("Last-Modified");

      if (etag) {
        feed.etag = etag;
      }

      if (lastModified) {
        feed.lastModified = lastModified;
      }

      // Parse the feed
      const content = await response.text();
      const parsedFeed = await parseFeed(content);

      // Update feed metadata
      if (parsedFeed.title) {
        feed.title = parsedFeed.title.value;
      }

      if (parsedFeed.description) {
        feed.description = parsedFeed.description.value;
      }

      // Check for WebSub hub
      if (parsedFeed.links) {
        const hubLink = parsedFeed.links.find((link) => link.rel === "hub");

        if (hubLink && hubLink.href) {
          feed.supportsWebSub = true;
          feed.webSubHub = hubLink.href;
        }
      }

      // Process feed entries
      let newItems = 0;

      if (parsedFeed.entries && parsedFeed.entries.length > 0) {
        for (const entry of parsedFeed.entries) {
          // Skip entries without an ID or link
          if (!entry.id && !entry.links?.[0]?.href) {
            continue;
          }

          // Use ID or link as GUID
          const guid = entry.id || entry.links?.[0]?.href || "";

          // Check if we already have this item
          const existingItem = await db.feeds.getItemByFeedAndGuid(
            feed.id,
            guid
          );

          if (existingItem) {
            // Check if the item has been updated
            if (entry.updated && existingItem.updated) {
              const entryUpdated = new Date(entry.updated);
              const existingUpdated = new Date(existingItem.updated);

              if (entryUpdated <= existingUpdated) {
                // Item hasn't been updated
                continue;
              }
            } else {
              // No update information, skip
              continue;
            }
          }

          // Get the item URL
          const url = entry.links?.[0]?.href || "";

          // Get the item title
          const title = entry.title?.value || "Untitled";

          // Get the item content
          const content =
            entry.content?.value || entry.description?.value || "";

          // Get the item summary
          const summary = entry.summary?.value || "";

          // Get the item author
          const author = entry.author?.name || "";

          // Get the item published date
          const published = entry.published
            ? new Date(entry.published)
            : entry.updated
            ? new Date(entry.updated)
            : now;

          // Get the item updated date
          const updated = entry.updated ? new Date(entry.updated) : undefined;

          // Get the item categories
          const categories =
            entry.categories?.map((category) => category.term) || [];

          // Create or update the item
          const feedItem: Omit<FeedItem, "id"> = {
            feedId: feed.id,
            guid,
            url,
            title,
            content,
            summary,
            author,
            published,
            updated,
            categories,
          };

          if (existingItem) {
            // Update the item
            await db.feeds.createItem({
              ...feedItem,
              id: existingItem.id,
            });
          } else {
            // Create a new item
            await db.feeds.createItem(feedItem);
            newItems++;
          }
        }
      }

      // Update the feed's last updated time if we found new items
      if (newItems > 0) {
        feed.lastUpdated = now;
      }

      // Update the feed
      await db.feeds.update(feed);

      // If we found new items, notify subscribers
      if (newItems > 0) {
        // Get the latest items
        const items = await db.feeds.getItemsByFeed(feed.id, 10);

        // Create a notification
        const notification = {
          feed: {
            id: feed.id,
            url: feed.url,
            title: feed.title,
          },
          items: items.map((item) => ({
            id: item.id,
            guid: item.guid,
            url: item.url,
            title: item.title,
            summary: item.summary,
            published: item.published,
          })),
        };

        // Notify subscribers
        await HubService.processContentNotification(
          feed.url,
          JSON.stringify(notification),
          "application/json" // for now, we only support on polling, we need to fix
        );
      }

      return {
        success: true,
        message: `Feed polled successfully, found ${newItems} new items`,
        newItems,
      };
    } catch (error: unknown) {
      console.error("Error polling feed:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Update the feed with the error
      try {
        const db = await getDatabase();

        feed.errorCount++;
        feed.lastError = `Error polling feed: ${errorMessage}`;
        feed.lastErrorTime = new Date();

        await db.feeds.update(feed);
      } catch (updateError) {
        console.error("Error updating feed with error:", updateError);
      }

      return {
        success: false,
        message: `Error polling feed: ${errorMessage}`,
        newItems: 0,
      };
    }
  }

  // Poll all feeds that need updating
  static async pollFeeds(): Promise<{
    success: boolean;
    message: string;
    polled: number;
    updated: number;
  }> {
    try {
      const db = await getDatabase();
      const now = new Date();

      // Get feeds that need polling
      const feeds = await db.feeds.getFeedsToUpdate(now);

      if (feeds.length === 0) {
        return {
          success: true,
          message: "No feeds need polling",
          polled: 0,
          updated: 0,
        };
      }

      // Poll each feed
      let polled = 0;
      let updated = 0;

      for (const feed of feeds) {
        const result = await PollingService.pollFeed(feed);
        polled++;

        if (result.success && result.newItems > 0) {
          updated++;
        }
      }

      return {
        success: true,
        message: `Polled ${polled} feeds, ${updated} had updates`,
        polled,
        updated,
      };
    } catch (error: unknown) {
      console.error("Error polling feeds:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        success: false,
        message: `Error polling feeds: ${errorMessage}`,
        polled: 0,
        updated: 0,
      };
    }
  }

  // Start the polling service
  static async start(): Promise<void> {
    console.log("Starting polling service...");

    // Poll feeds immediately
    await PollingService.pollFeeds();

    // Set up a cron job to poll feeds every minute
    Deno.cron("Poll RSS Feeds", "* * * * *", async () => {
      console.log("Running scheduled feed polling...");
      await PollingService.pollFeeds();
    });
  }
}
