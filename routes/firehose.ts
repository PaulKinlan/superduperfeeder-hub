// Firehose routes for real-time updates

import { Router, crypto } from "../deps.ts";
import type { Context } from "@oak/oak";
import { FirehoseService } from "../services/firehose.ts";
import { getDatabase } from "../utils/database.ts";
import { WebhookFilter } from "../models/webhook.ts";

const router = new Router();

// Webhook configuration endpoint
router.post("/firehose/webhook", async (ctx: Context) => {
  try {
    // Get the request body
    const body = await ctx.request.body.formData();

    // Validate the request
    if (!body || !body.has("url")) {
      ctx.response.status = 400;
      ctx.response.body = {
        success: false,
        message: "Missing required parameter: url",
      };
      return;
    }

    const url = body.get("url") as string;

    // Validate the URL
    try {
      new URL(url);
    } catch (error) {
      ctx.response.status = 400;
      ctx.response.body = {
        success: false,
        message: `Invalid URL: ${url}`,
      };
      return;
    }

    // Get the content type
    const contentType =
      (body.get("contentType") as string) || "application/json";

    // Get the filters
    const filters: WebhookFilter[] =
      JSON.parse((body.get("filters") as string) || "[]") || [];

    // Create the webhook
    const db = await getDatabase();
    const webhook = await db.webhooks.create({
      url: url,
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
