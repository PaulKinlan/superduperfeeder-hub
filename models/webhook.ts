// Webhook model for firehose functionality

import { crypto } from "../deps.ts";

// Interface for webhook data
export interface Webhook {
  id: string;
  url: string; // The URL to send updates to
  secret?: string; // Optional secret for signature verification
  contentType: string; // Content type to use (application/json, application/xml, etc.)
  active: boolean; // Whether the webhook is active
  created: Date; // When the webhook was created
  lastUsed?: Date; // When the webhook was last used
  errorCount: number; // Number of consecutive errors
  lastError?: string; // Last error message
  lastErrorTime?: Date; // When the last error occurred
  retryCount: number; // Number of retries for failed deliveries
  filters?: WebhookFilter[]; // Optional filters for the webhook
}

// Interface for webhook filter
export interface WebhookFilter {
  type: "topic" | "feed" | "keyword"; // Type of filter
  value: string; // Value to filter on
}

// Class for managing webhooks in DenoKV
export class WebhookStore {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  // Create a new webhook
  async create(
    data: Omit<Webhook, "id" | "created" | "errorCount" | "retryCount">
  ): Promise<Webhook> {
    const id = crypto.randomUUID();
    const webhook: Webhook = {
      id,
      created: new Date(),
      errorCount: 0,
      retryCount: 3, // Default to 3 retries
      ...data,
    };

    // Store in KV by ID
    await this.kv.set(["webhooks", id], webhook);

    return webhook;
  }

  // Get a webhook by ID
  async getById(id: string): Promise<Webhook | null> {
    const result = await this.kv.get<Webhook>(["webhooks", id]);
    return result.value;
  }

  // Update a webhook
  async update(webhook: Webhook): Promise<void> {
    await this.kv.set(["webhooks", webhook.id], webhook);
  }

  // Delete a webhook
  async delete(id: string): Promise<void> {
    await this.kv.delete(["webhooks", id]);
  }

  // Get all webhooks
  async getAll(): Promise<Webhook[]> {
    const entries = await this.kv.list<Webhook>({
      prefix: ["webhooks"],
    });

    const webhooks: Webhook[] = [];
    for await (const entry of entries) {
      webhooks.push(entry.value);
    }

    return webhooks;
  }

  // Get active webhooks
  async getActive(): Promise<Webhook[]> {
    const all = await this.getAll();
    return all.filter((webhook) => webhook.active);
  }

  // Get webhooks that match a feed
  async getMatchingWebhooks(feedId: string, topic: string): Promise<Webhook[]> {
    const active = await this.getActive();

    return active.filter((webhook) => {
      // If no filters, include all
      if (!webhook.filters || webhook.filters.length === 0) {
        return true;
      }

      // Check if any filter matches
      return webhook.filters.some((filter) => {
        if (filter.type === "feed" && filter.value === feedId) {
          return true;
        }

        if (filter.type === "topic" && filter.value === topic) {
          return true;
        }

        // Keyword filters would need to check against content
        // This is a simplified implementation
        return false;
      });
    });
  }
}
