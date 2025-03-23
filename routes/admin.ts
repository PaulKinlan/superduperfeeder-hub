// Admin routes for managing feeds, items, and subscriptions

import { Router } from "../deps.ts";
import type { Context } from "@oak/oak";
import { getDatabase } from "../utils/database.ts";
import { Feed, FeedItem } from "../models/feed.ts";
import { ExternalSubscription } from "../models/external_subscription.ts";
import { PollingService } from "../services/polling.ts";

const router = new Router();

// Admin authentication middleware
async function requireAdmin(ctx: Context, next: () => Promise<unknown>) {
  // For now, we'll skip authentication in development
  // In production, you would implement proper authentication here
  await next();
}

// Admin API routes
router.get("/api/admin/stats", requireAdmin, async (ctx: Context) => {
  const db = await getDatabase();

  // Get all feeds
  const feeds = await db.feeds.getAll();

  // Calculate statistics
  const totalFeeds = feeds.length;
  const activeFeeds = feeds.filter((feed) => feed.active).length;
  const feedsWithErrors = feeds.filter((feed) => feed.errorCount > 0).length;
  const webSubFeeds = feeds.filter((feed) => feed.supportsWebSub).length;

  // Get feeds that need polling soon
  const now = new Date();
  const feedsToUpdate = await db.feeds.getFeedsToUpdate(now);

  // Get recent items (limited to 50)
  const recentItems = await db.feeds.getRecentItems(50);

  // Get external subscriptions
  const subscriptions = await db.externalSubscriptions.getAll();

  ctx.response.body = {
    feeds: {
      total: totalFeeds,
      active: activeFeeds,
      withErrors: feedsWithErrors,
      webSub: webSubFeeds,
      needingUpdate: feedsToUpdate.length,
    },
    items: {
      recentCount: recentItems.length,
    },
    subscriptions: {
      total: subscriptions.length,
      expired: (await db.externalSubscriptions.getExpired()).length,
      needingRenewal: (await db.externalSubscriptions.getNeedingRenewal())
        .length,
    },
  };
});

// Get all feeds with optional filtering
router.get("/api/admin/feeds", requireAdmin, async (ctx: Context) => {
  const db = await getDatabase();
  const url = ctx.request.url;

  // Parse query parameters for filtering
  const status = url.searchParams.get("status"); // active, inactive, error
  const sort = url.searchParams.get("sort") || "lastFetched"; // url, title, lastFetched, lastUpdated
  const order = url.searchParams.get("order") || "desc"; // asc, desc

  // Get all feeds
  let feeds = await db.feeds.getAll();

  // Apply filters
  if (status === "active") {
    feeds = feeds.filter((feed) => feed.active);
  } else if (status === "inactive") {
    feeds = feeds.filter((feed) => !feed.active);
  } else if (status === "error") {
    feeds = feeds.filter((feed) => feed.errorCount > 0);
  }

  // Apply sorting
  feeds.sort((a, b) => {
    let valueA: any;
    let valueB: any;

    // Handle different sort fields
    if (sort === "url") {
      valueA = a.url;
      valueB = b.url;
    } else if (sort === "title") {
      valueA = a.title || "";
      valueB = b.title || "";
    } else if (sort === "lastUpdated") {
      valueA = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
      valueB = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
    } else {
      // Default to lastFetched
      valueA = a.lastFetched ? new Date(a.lastFetched).getTime() : 0;
      valueB = b.lastFetched ? new Date(b.lastFetched).getTime() : 0;
    }

    // Apply order
    if (order === "asc") {
      return valueA > valueB ? 1 : -1;
    } else {
      return valueA < valueB ? 1 : -1;
    }
  });

  // Calculate next update time for each feed
  const now = new Date();
  const feedsWithNextUpdate = feeds.map((feed) => {
    let nextUpdate: Date | null = null;

    if (feed.active && !feed.supportsWebSub && feed.lastFetched) {
      nextUpdate = new Date(feed.lastFetched);
      nextUpdate.setMinutes(nextUpdate.getMinutes() + feed.pollingInterval);
    }

    return {
      ...feed,
      nextUpdate: nextUpdate ? nextUpdate.toISOString() : null,
      nextUpdateIn: nextUpdate
        ? Math.max(0, nextUpdate.getTime() - now.getTime())
        : null,
    };
  });

  ctx.response.body = feedsWithNextUpdate;
});

// Get a specific feed by ID
router.get("/api/admin/feeds/:id", requireAdmin, async (ctx: Context) => {
  const db = await getDatabase();
  const id = ctx.request.url.pathname.split("/").pop();

  if (!id) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Feed ID is required" };
    return;
  }

  const feed = await db.feeds.getById(id);

  if (!feed) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Feed not found" };
    return;
  }

  // Calculate next update time
  let nextUpdate: Date | null = null;

  if (feed.active && !feed.supportsWebSub && feed.lastFetched) {
    nextUpdate = new Date(feed.lastFetched);
    nextUpdate.setMinutes(nextUpdate.getMinutes() + feed.pollingInterval);
  }

  const now = new Date();

  ctx.response.body = {
    ...feed,
    nextUpdate: nextUpdate ? nextUpdate.toISOString() : null,
    nextUpdateIn: nextUpdate
      ? Math.max(0, nextUpdate.getTime() - now.getTime())
      : null,
  };
});

// Get items for a specific feed
router.get("/api/admin/feeds/:id/items", requireAdmin, async (ctx: Context) => {
  const db = await getDatabase();
  const id = ctx.request.url.pathname.split("/").pop();
  const url = ctx.request.url;

  if (!id) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Feed ID is required" };
    return;
  }

  const feed = await db.feeds.getById(id);

  if (!feed) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Feed not found" };
    return;
  }

  // Parse query parameters
  const limit = parseInt(url.searchParams.get("limit") || "50");

  const items = await db.feeds.getItemsByFeed(id, limit);

  ctx.response.body = items;
});

// Get all feed items with filtering
router.get("/api/admin/items", requireAdmin, async (ctx: Context) => {
  const db = await getDatabase();
  const url = ctx.request.url;

  // Parse query parameters
  const limit = parseInt(url.searchParams.get("limit") || "50");
  const feedId = url.searchParams.get("feedId");

  let items: FeedItem[];

  if (feedId) {
    items = await db.feeds.getItemsByFeed(feedId, limit);
  } else {
    items = await db.feeds.getRecentItems(limit);
  }

  ctx.response.body = items;
});

// Get all external subscriptions
router.get("/api/admin/subscriptions", requireAdmin, async (ctx: Context) => {
  const db = await getDatabase();

  const subscriptions = await db.externalSubscriptions.getAll();

  ctx.response.body = subscriptions;
});

// Force update a feed
router.post(
  "/api/admin/feeds/:id/update",
  requireAdmin,
  async (ctx: Context) => {
    const db = await getDatabase();
    const id = ctx.request.url.pathname.split("/").pop();

    if (!id) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Feed ID is required" };
      return;
    }

    const feed = await db.feeds.getById(id);

    if (!feed) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Feed not found" };
      return;
    }

    // Force update the feed
    const result = await PollingService.pollFeed(feed);

    ctx.response.body = result;
  }
);

// Toggle feed active status
router.post(
  "/api/admin/feeds/:id/toggle",
  requireAdmin,
  async (ctx: Context) => {
    const db = await getDatabase();
    const id = ctx.request.url.pathname.split("/").pop();

    if (!id) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Feed ID is required" };
      return;
    }

    const feed = await db.feeds.getById(id);

    if (!feed) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Feed not found" };
      return;
    }

    // Toggle active status
    feed.active = !feed.active;

    // Update the feed
    await db.feeds.update(feed);

    ctx.response.body = { success: true, active: feed.active };
  }
);

export default router;
