// Firehose service for real-time updates

import { config } from "../config.ts";
import { getDatabase } from "../utils/database.ts";
import { Webhook } from "../models/webhook.ts";
import { FeedItem } from "../models/feed.ts";
import { crypto } from "../deps.ts";

// Interface for firehose event
export interface FirehoseEvent {
  id: string;
  type: "feed_update" | "subscription_update" | "system";
  timestamp: string;
  data: any;
}

// Class for handling firehose functionality
export class FirehoseService {
  // Send an event to webhooks
  static async sendToWebhooks(
    event: FirehoseEvent,
    feedId?: string,
    topic?: string
  ): Promise<void> {
    try {
      const db = await getDatabase();

      // Get matching webhooks
      let webhooks: Webhook[] = [];

      if (feedId && topic) {
        webhooks = await db.webhooks.getMatchingWebhooks(feedId, topic);
      } else {
        webhooks = await db.webhooks.getActive();
      }

      // Send the event to each webhook
      for (const webhook of webhooks) {
        this.sendToWebhook(webhook, event).catch((error) => {
          console.error(`Error sending event to webhook ${webhook.id}:`, error);
        });
      }
    } catch (error) {
      console.error("Error sending event to webhooks:", error);
    }
  }

  // Send an event to a webhook
  static async sendToWebhook(
    webhook: Webhook,
    event: FirehoseEvent
  ): Promise<boolean> {
    try {
      const db = await getDatabase();

      // Prepare the payload based on content type
      let body: string;

      switch (webhook.contentType) {
        case "application/json":
          body = JSON.stringify(event);
          break;
        case "application/xml":
          // Simple XML conversion
          body = `<event>
  <id>${event.id}</id>
  <type>${event.type}</type>
  <timestamp>${event.timestamp}</timestamp>
  <data>${JSON.stringify(event.data)}</data>
</event>`;
          break;
        default:
          body = JSON.stringify(event);
          break;
      }

      // Send the webhook request
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": webhook.contentType,
          "User-Agent": `SuperDuperFeeder/${config.version}`,
          "X-SuperDuperFeeder-Event": event.type,
          "X-SuperDuperFeeder-Delivery": event.id,
        },
        body,
      });

      // Update the webhook's last used time
      webhook.lastUsed = new Date();

      // Check if the request was successful
      if (!response.ok) {
        // Update error count and last error
        webhook.errorCount++;
        webhook.lastError = `HTTP error: ${response.status} ${response.statusText}`;
        webhook.lastErrorTime = new Date();

        await db.webhooks.update(webhook);

        return false;
      }

      // Reset error count
      webhook.errorCount = 0;
      webhook.lastError = undefined;
      webhook.lastErrorTime = undefined;

      await db.webhooks.update(webhook);

      return true;
    } catch (error: unknown) {
      // Update error count and last error
      try {
        const db = await getDatabase();

        webhook.errorCount++;
        webhook.lastError =
          error instanceof Error ? error.message : String(error);
        webhook.lastErrorTime = new Date();

        await db.webhooks.update(webhook);
      } catch (updateError) {
        console.error("Error updating webhook with error:", updateError);
      }

      return false;
    }
  }

  // Publish a feed update event
  static async publishFeedUpdate(
    feedId: string,
    topic: string,
    items: FeedItem[]
  ): Promise<void> {
    const event: FirehoseEvent = {
      id: crypto.randomUUID(),
      type: "feed_update",
      timestamp: new Date().toISOString(),
      data: {
        feedId,
        topic,
        items: items.map((item) => ({
          id: item.id,
          guid: item.guid,
          url: item.url,
          title: item.title,
          summary: item.summary,
          published: item.published,
        })),
      },
    };

    // Send to webhooks
    await this.sendToWebhooks(event, feedId, topic);
  }

  // Publish a subscription update event
  static async publishSubscriptionUpdate(
    action: "subscribe" | "unsubscribe",
    topic: string,
    callback: string
  ): Promise<void> {
    const event: FirehoseEvent = {
      id: crypto.randomUUID(),
      type: "subscription_update",
      timestamp: new Date().toISOString(),
      data: {
        action,
        topic,
        callback,
      },
    };

    // Send to webhooks
    await this.sendToWebhooks(event);
  }

  // Publish a system event
  static async publishSystemEvent(
    message: string,
    details?: any
  ): Promise<void> {
    const event: FirehoseEvent = {
      id: crypto.randomUUID(),
      type: "system",
      timestamp: new Date().toISOString(),
      data: {
        message,
        details,
      },
    };

    // Send to webhooks
    await this.sendToWebhooks(event);
  }
}
