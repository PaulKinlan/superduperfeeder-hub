// User callback model for forwarding updates to external services

import { crypto } from "../deps.ts";

// Interface for user callback data, this is the webhook model
export interface UserCallback {
  id: string;
  topic: string; // The feed URL
  callbackUrl: string; // The external URL to forward updates to
  created: Date;
  lastUsed?: Date;
  errorCount: number;
  lastError?: string;
  lastErrorTime?: Date; // When the last error occurred
  verified: boolean; // Whether the callback has been verified
  verificationToken?: string; // Token for verifying ownership
  verificationExpires?: Date; // When the verification token expires
}

// Class for managing user callbacks in DenoKV
export class UserCallbackStore {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  // Create a new user callback
  async create(
    data: Omit<UserCallback, "id" | "created" | "errorCount">
  ): Promise<UserCallback> {
    const id = crypto.randomUUID();
    const callback: UserCallback = {
      id,
      created: new Date(),
      errorCount: 0,
      ...data,
    };

    // Store in KV by ID
    await this.kv.set(["user_callbacks", id], callback);

    // Also create an index by topic and callbackUrl
    await this.kv.set(
      ["user_callbacks_by_topic_url", data.topic, data.callbackUrl],
      id
    );

    return callback;
  }

  // Get a user callback by ID
  async getById(id: string): Promise<UserCallback | null> {
    const result = await this.kv.get<UserCallback>(["user_callbacks", id]);
    return result.value;
  }

  // Get a user callback by topic and callbackUrl
  async getByTopicAndUrl(
    topic: string,
    callbackUrl: string
  ): Promise<UserCallback | null> {
    const idResult = await this.kv.get<string>([
      "user_callbacks_by_topic_url",
      topic,
      callbackUrl,
    ]);

    if (!idResult.value) {
      return null;
    }

    return this.getById(idResult.value);
  }

  // Get all user callbacks for a topic
  async getByTopic(topic: string): Promise<UserCallback[]> {
    const entries = await this.kv.list<string>({
      prefix: ["user_callbacks_by_topic_url", topic],
    });

    const callbacks: UserCallback[] = [];
    for await (const entry of entries) {
      const callback = await this.getById(entry.value);
      if (callback) {
        callbacks.push(callback);
      }
    }

    return callbacks;
  }

  // Update a user callback
  async update(callback: UserCallback): Promise<void> {
    await this.kv.set(["user_callbacks", callback.id], callback);
  }

  // Delete a user callback
  async delete(id: string): Promise<void> {
    const callback = await this.getById(id);
    if (!callback) {
      return;
    }

    // Remove from KV
    await this.kv.delete(["user_callbacks", id]);

    // Remove from indexes
    await this.kv.delete([
      "user_callbacks_by_topic_url",
      callback.topic,
      callback.callbackUrl,
    ]);
  }

  // Get all user callbacks
  async getAll(): Promise<UserCallback[]> {
    const entries = await this.kv.list<UserCallback>({
      prefix: ["user_callbacks"],
    });

    const callbacks: UserCallback[] = [];
    for await (const entry of entries) {
      callbacks.push(entry.value);
    }

    return callbacks;
  }
}
