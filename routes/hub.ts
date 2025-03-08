// WebSub hub routes

import { Router } from "../deps.ts";
import type { Context } from "@oak/oak";
import { HubService } from "../services/hub.ts";
import { FirehoseService } from "../services/firehose.ts";
import { contentType } from "jsr:@std/media-types@^1.1.0/content-type";

const router = new Router();

const getHubDataFromRequest = async (
  ctx: Context
): Promise<{ [x: string]: string } | undefined> => {
  if (ctx.request.hasBody) {
    const body = await ctx.request.body.formData();
    if (body) {
      return {
        "hub.mode": body.get("hub.mode") as string,
        "hub.topic": body.get("hub.topic") as string,
        "hub.callback": body.get("hub.callback") as string,
        "hub.leaseSeconds": body.get("hub.lease_seconds") as string,
        "hub.secret": body.get("hub.secret") as string,
      };
    }
  }
};

// API endpoints for the UI
router.post("/api/subscribe", async (ctx: Context) => {
  try {
    // Get the request body
    const body = await ctx.request.body.formData();
    const params = await getHubDataFromRequest(ctx);

    if (!params) {
      ctx.response.status = 400;
      ctx.response.body = {
        success: false,
        message: "Invalid request: missing parameters",
      };
      return;
    }

    // Ensure this is a subscribe request
    params["hub.mode"] = "subscribe";

    const topic = params["hub.topic"];
    const callback = params["hub.callback"];
    const leaseSeconds = params["hub.leaseSeconds"]
      ? parseInt(params["hub.leaseSeconds"] as string)
      : undefined;
    const secret = params["hub.secret"] as string | undefined;

    // Process the subscription request
    const result = await HubService.processSubscriptionRequest({
      mode: "subscribe",
      topic,
      callback,
      leaseSeconds,
      secret,
    });

    // Publish a subscription update event
    if (result.success) {
      await FirehoseService.publishSubscriptionUpdate(
        "subscribe",
        topic,
        callback
      );
    }

    // Return the result
    ctx.response.status = result.success ? 202 : 400;
    ctx.response.body = result;
  } catch (error: unknown) {
    console.error("Error processing subscription request:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: `Internal server error: ${errorMessage}`,
    };
  }
});

router.post("/api/unsubscribe", async (ctx: Context) => {
  try {
    // Get the request body
    const body = await ctx.request.body.formData();
    const params = await getHubDataFromRequest(ctx);

    if (!params) {
      ctx.response.status = 400;
      ctx.response.body = {
        success: false,
        message: "Invalid request: missing parameters",
      };
      return;
    }

    // Ensure this is an unsubscribe request
    params["hub.mode"] = "unsubscribe";

    const topic = params["hub.topic"];
    const callback = params["hub.callback"];

    // Process the unsubscription request
    const result = await HubService.processSubscriptionRequest({
      mode: "unsubscribe",
      topic,
      callback,
    });

    // Publish a subscription update event
    if (result.success) {
      await FirehoseService.publishSubscriptionUpdate(
        "unsubscribe",
        topic,
        callback
      );
    }

    // Return the result
    ctx.response.status = result.success ? 202 : 400;
    ctx.response.body = result;
  } catch (error: unknown) {
    console.error("Error processing unsubscription request:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: `Internal server error: ${errorMessage}`,
    };
  }
});

// WebSub hub endpoint
router.post("/", async (ctx: Context) => {
  try {
    // Get the request body
    const body = await ctx.request.body.formData();
    console.log("body", body);
    const params =
      (await getHubDataFromRequest(ctx)) ||
      Object.fromEntries(new URL(ctx.request.url).searchParams);

    console.log("params", params);
    const mode = params["hub.mode"];
    const topic = params["hub.topic"];

    // Check if this is a publish request
    if (mode === "publish" && topic) {
      // Process the publish request
      console.log("publish topic", topic);
      const result = await HubService.processPublishRequest(topic);

      // Return the result
      ctx.response.status = result.success ? 202 : 400;
      ctx.response.body = result;
      return;
    }

    // Check if this is a subscription request
    if ((mode === "subscribe" || mode === "unsubscribe") && topic) {
      const callback = params["hub.callback"];
      const leaseSeconds = params["hub.lease_seconds"]
        ? parseInt(params["hub.lease_seconds"] as string)
        : undefined;
      const secret = params["hub.secret"] as string | undefined;

      // Process the subscription request
      const result = await HubService.processSubscriptionRequest({
        mode: mode as "subscribe" | "unsubscribe",
        topic,
        callback,
        leaseSeconds,
        secret,
      });

      // Publish a subscription update event
      if (result.success) {
        await FirehoseService.publishSubscriptionUpdate(
          mode as "subscribe" | "unsubscribe",
          topic,
          callback
        );
      }

      // Return the result
      ctx.response.status = result.success ? 202 : 400;
      ctx.response.body = result;
      return;
    }

    // Check if this is a content notification
    if (ctx.request.method === "POST" && ctx.request.url.pathname === "/") {
      // Get the topic from the Link header
      const linkHeader = ctx.request.headers.get("Link");
      let topic = "";

      if (linkHeader) {
        const matches = linkHeader.match(/<([^>]+)>;\s*rel=["']?self["']?/);
        if (matches && matches[1]) {
          topic = matches[1];
        }
      }

      // If no topic in Link header, check if it's in the body
      if (!topic && body.has("topic")) {
        topic = body.get(topic) as string;
      }

      // If still no topic, return an error
      if (!topic) {
        ctx.response.status = 400;
        ctx.response.body = {
          success: false,
          message: "Missing topic",
        };
        return;
      }

      // Get the content
      let content = "";

      if (typeof body === "string") {
        content = body;
      } else {
        content = JSON.stringify(body);
      }

      const contentType = ctx.request.headers.get("Content-Type") || "";

      // Process the content notification
      const result = await HubService.processContentNotification(
        topic,
        content,
        contentType
      );

      // Return the result
      ctx.response.status = result.success ? 202 : 400;
      ctx.response.body = result;
      return;
    }

    // If we get here, it's an invalid request
    ctx.response.status = 400;
    ctx.response.body = {
      success: false,
      message: "Invalid request",
    };
  } catch (error: unknown) {
    console.error("Error processing hub request:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: `Internal server error: ${errorMessage}`,
    };
  }
});

export default router;
