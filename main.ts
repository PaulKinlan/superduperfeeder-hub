import { Application, oakCors } from "./deps.ts";
import type { Context, Next } from "@oak/oak";
import { config } from "./config.ts";

import { getDatabase } from "./utils/database.ts";

// Import routes
import router from "./routes/index.ts";
import adminRouter from "./routes/admin.ts";

// Import services
import { PollingService } from "./services/polling.ts";
import { STATUS_CODE } from "@std/http";
import { Feed } from "./models/feed.ts";
import { ContentDistributionMessage } from "./models/queue.ts";
import { HubService } from "./services/hub.ts";

// Initialize the application
const app = new Application();

// Basic middleware
app.use(oakCors()); // Enable CORS
app.use(async (ctx: Context, next: Next) => {
  try {
    await next();
  } catch (err: unknown) {
    console.error(err);
    const status =
      err instanceof Error && "status" in err
        ? (err as { status: number }).status
        : STATUS_CODE.InternalServerError;

    const message =
      err instanceof Error ? err.message : "Internal Server Error";

    ctx.response.status = status;
    ctx.response.body = {
      success: false,
      message,
    };
  }
});

// Log requests
app.use(async (ctx: Context, next: Next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`${ctx.request.method} ${ctx.request.url.pathname} - ${ms}ms`);
});

// Apply routers
app.use(router.routes());
app.use(router.allowedMethods());
app.use(adminRouter.routes());
app.use(adminRouter.allowedMethods());

// Start the server
const port = config.port || 8000;
console.log(`Server running on http://localhost:${port}`);

// Start the services
console.log("Starting services...");

Deno.cron("Poll RSS Feeds", "*/1 * * * *", async () => {
  console.log("Running scheduled feed polling...");
  console.log(await PollingService.pollFeeds());
});

// Set up a cron job to clear expired subscriptions every hour
// Deno.cron("Clear Expired Subscriptions", "0 * * * *", async () => {
//   console.log("Running scheduled cleanup of expired subscriptions...");
//   console.log(await WebhookService.clearExpiredSubscriptions());
// });

// Set up a queue to process async tasks,
const kv = await Deno.openKv();

const isFeed = (data: unknown): data is Feed => {
  return (
    typeof data === "object" &&
    data !== null &&
    "id" in data &&
    "url" in data &&
    "active" in data &&
    "supportsWebSub" in data
  );
};

const isContentDistributionMessage = (
  data: unknown
): data is ContentDistributionMessage => {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "contentDistribution" &&
    "subscription" in data &&
    "feedUrl" in data &&
    "content" in data &&
    "contentType" in data
  );
};

kv.listenQueue(async (message: unknown) => {
  if (isFeed(message)) {
    console.log("Processing feed from Queue", message);
    try {
      const result = await PollingService.pollFeed(message);
      console.log("Polling result:", message.url, result);
    } catch (error) {
      // If an individual feed polling operation fails, log the error but continue with other feeds
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`Error polling feed ${message.url}: ${errorMessage}`);

      // Update the feed with the error
      try {
        const db = await getDatabase();
        message.errorCount++;
        message.lastError = `Unhandled error: ${errorMessage}`;
        message.lastErrorTime = new Date();
        await db.feeds.update(message);
      } catch (updateError) {
        console.error("Error updating feed with error:", updateError);
      }
    }
  } else if (isContentDistributionMessage(message)) {
    console.log("Processing content distribution message from Queue", message);

    await HubService.distributeContent(
      message.subscription,
      message.content,
      message.contentType
    );
  }
});

// Start the server
await app.listen({ port });
