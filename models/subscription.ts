// Subscription model for WebSub/PubSubHubbub

import { crypto } from "../deps.ts";

// Interface for subscription data
export interface Subscription {
  id: string;
  topic: string; // The URL of the topic (feed) being subscribed to
  callback: string; // The subscriber's callback URL
  secret?: string; // Optional secret for signature verification
  leaseSeconds: number; // How long the subscription is valid for
  created: Date; // When the subscription was created
  expires: Date; // When the subscription expires
  verified: boolean; // Whether the subscription has been verified
  verificationToken?: string; // Token used during verification process
  verificationExpires?: Date; // When the verification token expires
}

// Interface for subscription creation
export interface SubscriptionRequest {
  topic: string;
  callback: string;
  secret?: string;
  leaseSeconds?: number;
  mode: "subscribe" | "unsubscribe";
}

// Interface for subscription verification
export interface SubscriptionVerification {
  id: string;
  topic: string;
  callback: string;
  mode: "subscribe" | "unsubscribe";
  leaseSeconds?: number;
  challenge: string;
  verificationToken: string;
  expires: Date;
}

// Class for managing subscriptions in DenoKV
export class SubscriptionStore {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  // Create a new subscription
  async create(data: Omit<Subscription, "id">): Promise<Subscription> {
    const id = crypto.randomUUID();
    const subscription: Subscription = {
      id,
      ...data,
    };

    // Store in KV by ID
    await this.kv.set(["subscriptions", id], subscription);

    // Also create an index by topic and callback
    await this.kv.set(
      ["subscriptions_by_topic_callback", data.topic, data.callback],
      id
    );

    return subscription;
  }

  // Get a subscription by ID
  async getById(id: string): Promise<Subscription | null> {
    const result = await this.kv.get<Subscription>(["subscriptions", id]);
    return result.value;
  }

  // Get a subscription by topic and callback
  async getByTopicAndCallback(
    topic: string,
    callback: string
  ): Promise<Subscription | null> {
    const idResult = await this.kv.get<string>([
      "subscriptions_by_topic_callback",
      topic,
      callback,
    ]);

    if (!idResult.value) {
      return null;
    }

    return this.getById(idResult.value);
  }

  // Update a subscription
  async update(subscription: Subscription): Promise<void> {
    await this.kv.set(["subscriptions", subscription.id], subscription);
  }

  // Delete a subscription
  async delete(id: string): Promise<void> {
    const subscription = await this.getById(id);
    if (!subscription) {
      return;
    }

    // Remove from KV
    await this.kv.delete(["subscriptions", id]);

    // Remove from index
    await this.kv.delete([
      "subscriptions_by_topic_callback",
      subscription.topic,
      subscription.callback,
    ]);
  }

  // Get all subscriptions for a topic
  async getByTopic(topic: string): Promise<Subscription[]> {
    const entries = await this.kv.list<string>({
      prefix: ["subscriptions_by_topic_callback", topic],
    });

    const subscriptions: Subscription[] = [];
    for await (const entry of entries) {
      const subscription = await this.getById(entry.value);
      if (subscription) {
        subscriptions.push(subscription);
      }
    }

    return subscriptions;
  }

  // Get all expired subscriptions
  async getExpired(): Promise<Subscription[]> {
    const now = new Date();
    const entries = await this.kv.list<Subscription>({
      prefix: ["subscriptions"],
    });

    const expired: Subscription[] = [];
    for await (const entry of entries) {
      const subscription = entry.value;
      if (subscription.expires < now) {
        expired.push(subscription);
      }
    }

    return expired;
  }
}
