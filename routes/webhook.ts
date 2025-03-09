// Webhook routes for subscribing to external WebSub hubs

import { Router } from "../deps.ts";
import type { Context } from "@oak/oak";
import { WebhookService } from "../services/webhook.ts";

const router = new Router();

// Webhook endpoint for subscribing to feeds
router.post("/api/webhook", async (ctx: Context) => {
  try {
    // Get the topic URL and callback URL from the request
    const body = await ctx.request.body.formData();
    const topic = body.get("topic") as string;
    const callback = body.get("callback") as string | undefined;

    if (!topic) {
      ctx.response.status = 400;
      ctx.response.body = {
        success: false,
        message: "Missing topic parameter",
      };
      return;
    }

    // Call WebhookService.subscribeToFeed with the callback URL
    const result = await WebhookService.subscribeToFeed(topic, callback);

    // Return appropriate response
    ctx.response.status = result.success ? 202 : 400;
    ctx.response.body = result;
  } catch (error: unknown) {
    console.error("Error processing webhook request:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: `Internal server error: ${errorMessage}`,
    };
  }
});

// Callback route for external hubs
router.all("/callback/:id", async (ctx: Context) => {
  try {
    // Get the ID from the URL path
    const id = ctx.request.url.pathname.split("/").pop();
    const callbackPath = `/callback/${id}`;

    // Get query parameters for verification
    const query = ctx.request.url.searchParams;
    const mode = query.get("hub.mode");
    const topic = query.get("hub.topic");
    const challenge = query.get("hub.challenge");
    const leaseSeconds = query.get("hub.lease_seconds")
      ? parseInt(query.get("hub.lease_seconds") as string)
      : undefined;

    // If this is a verification request
    if (mode && topic) {
      const result = await WebhookService.handleCallback(
        callbackPath,
        mode,
        topic,
        challenge || undefined,
        leaseSeconds
      );

      if (result.success && result.challenge) {
        // For verification requests, we need to return the challenge as plain text
        ctx.response.type = "text/plain";
        ctx.response.body = result.challenge;
        return;
      }

      ctx.response.status = result.success ? 200 : 404;
      ctx.response.body = result.message;
      return;
    }

    // If this is a content notification (POST)
    if (ctx.request.method === "POST") {
      // Get the topic from the request
      const topic = ctx.request.headers
        .get("Link")
        ?.match(/<([^>]+)>;\s*rel=["']?self["']?/)?.[1];

      if (!topic) {
        ctx.response.status = 400;
        ctx.response.body = "Missing topic";
        return;
      }

      // Get the content type and body
      const contentType =
        ctx.request.headers.get("Content-Type") || "application/octet-stream";
      const body = await ctx.request.body.text();

      // Process the content
      const result = await WebhookService.handleCallback(
        callbackPath,
        "content",
        topic,
        undefined,
        undefined,
        body,
        contentType
      );

      ctx.response.status = result.success ? 200 : 400;
      ctx.response.body = result.message;
      return;
    }

    // Invalid request
    ctx.response.status = 400;
    ctx.response.body = "Invalid request";
  } catch (error: unknown) {
    console.error("Error processing callback:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    ctx.response.status = 500;
    ctx.response.body = `Internal server error: ${errorMessage}`;
  }
});

export default router;
