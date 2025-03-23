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
      // ensure the feeds are not fetched at the same time, right now they are batched into the same 10 minute block.
      now.setMinutes(now.getMinutes() - Math.floor(Math.random() * 5));
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

      // Update feed metadata safely
      try {
        if (parsedFeed.title) {
          if (typeof parsedFeed.title === "string") {
            feed.title = parsedFeed.title;
          } else if (
            typeof parsedFeed.title === "object" &&
            parsedFeed.title !== null
          ) {
            feed.title = parsedFeed.title.value || parsedFeed.title.toString();
          }
        }
      } catch (e) {
        console.error("Error extracting feed title:", e);
      }

      try {
        if (parsedFeed.description) {
          if (typeof parsedFeed.description === "string") {
            feed.description = parsedFeed.description;
          } else if (
            typeof parsedFeed.description === "object" &&
            parsedFeed.description !== null
          ) {
            feed.description =
              parsedFeed.description.value || parsedFeed.description.toString();
          }
        }
      } catch (e) {
        console.error("Error extracting feed description:", e);
      }

      // Check for WebSub hub
      try {
        if (parsedFeed.links && Array.isArray(parsedFeed.links)) {
          for (const link of parsedFeed.links) {
            if (
              typeof link === "object" &&
              link !== null &&
              link.rel === "hub" &&
              link.href
            ) {
              feed.supportsWebSub = true;
              feed.webSubHub = link.href;
              break;
            }
          }
        }
      } catch (e) {
        console.error("Error checking for WebSub hub:", e);
      }

      // Process feed entries
      let newItems = 0;
      let mostRecentEntryId: string | undefined;

      if (parsedFeed.entries && parsedFeed.entries.length > 0) {
        // Sort entries by published/updated date, newest first
        const sortedEntries = [...parsedFeed.entries].sort((a, b) => {
          const aDate = a.updated || a.published || "";
          const bDate = b.updated || b.published || "";
          return new Date(bDate).getTime() - new Date(aDate).getTime();
        });

        // Track the most recent entry ID for updating lastProcessedEntryId
        if (sortedEntries.length > 0) {
          mostRecentEntryId =
            sortedEntries[0].id ||
            sortedEntries[0].links?.[0]?.href ||
            undefined;
        }

        for (const entry of parsedFeed.entries) {
          // Skip entries without an ID or link
          if (!entry.id && !entry.links?.[0]?.href) {
            continue;
          }

          // Use ID or link as GUID
          const guid = entry.id || entry.links?.[0]?.href || "";

          // If this entry ID matches our lastProcessedEntryId, we can skip this and all older entries
          if (feed.lastProcessedEntryId && guid === feed.lastProcessedEntryId) {
            // We've reached the last processed entry, so we can stop processing
            break;
          }

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

          // Extract item properties safely
          let title = "Untitled";
          let content = "";
          let summary = "";
          let author = "";
          let published = now;
          let updated: Date | undefined = undefined;
          let categories: string[] = [];

          try {
            // Get the item title
            title =
              typeof entry.title === "string"
                ? entry.title
                : entry.title?.value || entry.title?.toString() || "Untitled";
          } catch (e) {
            console.error("Error extracting entry title:", e);
          }

          try {
            // Get the item content
            content =
              typeof entry.content === "string"
                ? entry.content
                : entry.content?.value ||
                  (typeof entry.description === "string"
                    ? entry.description
                    : entry.description?.value || "");
          } catch (e) {
            console.error("Error extracting entry content:", e);
          }

          try {
            // Get the item summary
            summary =
              typeof entry.summary === "string"
                ? entry.summary
                : entry.summary?.value || "";
          } catch (e) {
            console.error("Error extracting entry summary:", e);
          }

          try {
            // Get the item author
            author =
              typeof entry.author === "string"
                ? entry.author
                : entry.author?.name || "";
          } catch (e) {
            console.error("Error extracting entry author:", e);
          }

          try {
            // Get the item published date
            published = entry.published
              ? new Date(entry.published)
              : entry.updated
              ? new Date(entry.updated)
              : now;
          } catch (e) {
            console.error("Error extracting entry published date:", e);
          }

          try {
            // Get the item updated date
            updated = entry.updated ? new Date(entry.updated) : undefined;
          } catch (e) {
            console.error("Error extracting entry updated date:", e);
          }

          try {
            // Get the item categories
            if (entry.categories && Array.isArray(entry.categories)) {
              categories = entry.categories
                .map((category) => {
                  if (typeof category === "string") return category;
                  if (typeof category === "object" && category !== null) {
                    return category.term || category.toString();
                  }
                  return null;
                })
                .filter(
                  (category): category is string =>
                    category !== null && category !== undefined
                );
            }
          } catch (e) {
            console.error("Error extracting entry categories:", e);
          }

          // Create or update the item
          const feedItem: Omit<FeedItem, "id"> = {
            feedId: feed.id,
            guid,
            url,
            title,
            content: "", // We don't need to store this
            summary: "", // We dn't need to store this
            author,
            published,
            updated,
            categories: [], // We don't need to store this,
          };

          if (existingItem) {
            // For existing items, we need to create a new item
            // Since there's no direct update method for feed items
            // We'll use createItem which will overwrite the existing item
            console.log("Updating existing item:", feedItem);
            await db.feeds.createItem({
              ...feedItem,
              id: existingItem.id,
            } as any); // Use type assertion to bypass TypeScript check
          } else {
            // Create a new item
            console.log("Creating new item:", feedItem);
            await db.feeds.createItem(feedItem);
            newItems++;
          }
        }
      }

      // Update the feed's last updated time and lastProcessedEntryId if we found new items
      if (newItems > 0) {
        feed.lastUpdated = now;
      }

      // Update the lastProcessedEntryId if we have a new most recent entry
      if (mostRecentEntryId) {
        feed.lastProcessedEntryId = mostRecentEntryId;
      }

      // Update the feed
      await db.feeds.update(feed);

      // If we found new items, notify subscribers
      if (newItems > 0) {
        // Instead of getting items from the database, use the parsed feed content directly
        // This ensures subscribers get the complete, original feed content
        console.log("Processing content notification for", feed.url);
        // Notify subscribers with the original feed content
        await HubService.processContentNotification(
          feed.url,
          content, // Use the original feed content from the fetch
          response.headers.get("Content-Type") || "application/rss+xml"
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
  }> {
    const db = await getDatabase();
    const now = new Date();

    // Get feeds that need polling
    const feeds = await db.feeds.getFeedsToUpdate(now);

    if (feeds.length === 0) {
      return {
        success: true,
        message: "No feeds need polling",
        polled: 0,
      };
    }

    // Poll each feed
    let queued = 0;

    for (const feed of feeds) {
      console.log(`Queuing feed poll: ${feed.url}`);
      await db.queue.enqueue(feed);
      queued++;
    }

    return {
      success: true,
      message: `Queued ${queued} feeds`,
      polled: queued,
    };
  }
}
