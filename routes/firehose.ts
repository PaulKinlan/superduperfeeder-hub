// Firehose routes for real-time updates

import { Router, crypto } from "../deps.ts";
import type { Context } from "@oak/oak";
import { FirehoseService } from "../services/firehose.ts";
import { getDatabase } from "../utils/database.ts";

const router = new Router();

// WebSocket endpoint for firehose
router.get("/firehose/ws", async (ctx: Context) => {
  if (!ctx.isUpgradable) {
    ctx.response.status = 400;
    ctx.response.body = {
      success: false,
      message: "WebSocket upgrade required",
    };
    return;
  }

  try {
    // Upgrade the connection to WebSocket
    const ws = await ctx.upgrade();

    // Register the client
    const unregister = FirehoseService.registerClient("ws", (event) => {
      ws.send(JSON.stringify(event));
    });

    // Handle close
    ws.onclose = () => {
      unregister();
    };

    // Handle errors
    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      unregister();
    };

    // Send a welcome message
    ws.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "system",
        timestamp: new Date().toISOString(),
        data: {
          message: "Connected to firehose WebSocket",
        },
      })
    );
  } catch (error: unknown) {
    console.error("Error upgrading to WebSocket:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: `Internal server error: ${errorMessage}`,
    };
  }
});

// Server-Sent Events endpoint for firehose
router.get("/firehose/sse", async (ctx: Context) => {
  try {
    // Set up SSE headers
    ctx.response.headers.set("Content-Type", "text/event-stream");
    ctx.response.headers.set("Cache-Control", "no-cache");
    ctx.response.headers.set("Connection", "keep-alive");

    // Create a target for the SSE stream
    const target = (ctx.response.body = new TransformStream());
    const writer = target.writable.getWriter();

    // Function to send an event
    const sendEvent = async (event: any) => {
      try {
        const data = JSON.stringify(event);
        await writer.write(
          new TextEncoder().encode(`id: ${event.id}\ndata: ${data}\n\n`)
        );
      } catch (error) {
        console.error("Error sending SSE event:", error);
      }
    };

    // Register the client
    const unregister = FirehoseService.registerClient("sse", sendEvent);

    // Handle close
    ctx.request.originalRequest.signal?.addEventListener("abort", () => {
      unregister();
      writer.close().catch(console.error);
    });

    // Send a welcome message
    await sendEvent({
      id: crypto.randomUUID(),
      type: "system",
      timestamp: new Date().toISOString(),
      data: {
        message: "Connected to firehose SSE",
      },
    });

    // Send a keep-alive every 30 seconds
    const keepAliveInterval = setInterval(async () => {
      try {
        await writer.write(new TextEncoder().encode(": keep-alive\n\n"));
      } catch (error) {
        console.error("Error sending keep-alive:", error);
        clearInterval(keepAliveInterval);
        unregister();
        writer.close().catch(console.error);
      }
    }, 30000);

    // Clean up the interval when the connection is closed
    ctx.request.originalRequest.signal?.addEventListener("abort", () => {
      clearInterval(keepAliveInterval);
    });
  } catch (error: unknown) {
    console.error("Error setting up SSE:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: `Internal server error: ${errorMessage}`,
    };
  }
});

// Webhook configuration endpoint
router.post("/firehose/webhook", async (ctx: Context) => {
  try {
    // Get the request body
    const body = await ctx.request.body().value;

    // Validate the request
    if (!body.url) {
      ctx.response.status = 400;
      ctx.response.body = {
        success: false,
        message: "Missing required parameter: url",
      };
      return;
    }

    // Validate the URL
    try {
      new URL(body.url);
    } catch (error) {
      ctx.response.status = 400;
      ctx.response.body = {
        success: false,
        message: `Invalid URL: ${body.url}`,
      };
      return;
    }

    // Get the content type
    const contentType = body.contentType || "application/json";

    // Get the filters
    const filters = body.filters || [];

    // Create the webhook
    const db = await getDatabase();
    const webhook = await db.webhooks.create({
      url: body.url,
      contentType,
      active: true,
      filters,
    });

    // Return the webhook
    ctx.response.status = 201;
    ctx.response.body = {
      success: true,
      message: "Webhook created",
      webhook: {
        id: webhook.id,
        url: webhook.url,
        contentType: webhook.contentType,
        active: webhook.active,
        created: webhook.created,
        filters: webhook.filters,
      },
    };
  } catch (error: unknown) {
    console.error("Error creating webhook:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: `Internal server error: ${errorMessage}`,
    };
  }
});

// Delete webhook endpoint
router.delete("/firehose/webhook/:id", async (ctx: Context) => {
  try {
    const id = ctx.request.url.searchParams.get("id");

    if (!id) {
      ctx.response.status = 400;
      ctx.response.body = {
        success: false,
        message: "Missing webhook ID",
      };
      return;
    }

    // Get the webhook
    const db = await getDatabase();
    const webhook = await db.webhooks.getById(id);

    if (!webhook) {
      ctx.response.status = 404;
      ctx.response.body = {
        success: false,
        message: `Webhook not found: ${id}`,
      };
      return;
    }

    // Delete the webhook
    await db.webhooks.delete(id);

    // Return success
    ctx.response.status = 200;
    ctx.response.body = {
      success: true,
      message: "Webhook deleted",
    };
  } catch (error: unknown) {
    console.error("Error deleting webhook:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: `Internal server error: ${errorMessage}`,
    };
  }
});

// Get webhooks endpoint
router.get("/firehose/webhook", async (ctx: Context) => {
  try {
    // Get all webhooks
    const db = await getDatabase();
    const webhooks = await db.webhooks.getAll();

    // Return the webhooks
    ctx.response.status = 200;
    ctx.response.body = {
      success: true,
      webhooks: webhooks.map((webhook) => ({
        id: webhook.id,
        url: webhook.url,
        contentType: webhook.contentType,
        active: webhook.active,
        created: webhook.created,
        lastUsed: webhook.lastUsed,
        errorCount: webhook.errorCount,
        lastError: webhook.lastError,
        lastErrorTime: webhook.lastErrorTime,
        filters: webhook.filters,
      })),
    };
  } catch (error: unknown) {
    console.error("Error getting webhooks:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: `Internal server error: ${errorMessage}`,
    };
  }
});

export default router;
