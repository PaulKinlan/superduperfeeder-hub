// WebSub hub service

import { config } from "../config.ts";
import { getDatabase } from "../utils/database.ts";
import { Subscription, SubscriptionRequest } from "../models/subscription.ts";
import { Feed } from "../models/feed.ts";
import { parseFeed } from "../deps.ts";
import { crypto } from "../deps.ts";

// Class for handling WebSub hub functionality
export class HubService {
  // Process a subscription request
  static async processSubscriptionRequest(
    request: SubscriptionRequest
  ): Promise<{ success: boolean; message: string; id?: string }> {
    try {
      const db = await getDatabase();

      // Validate the request
      if (!request.topic || !request.callback || !request.mode) {
        return {
          success: false,
          message: "Missing required parameters: topic, callback, or mode",
        };
      }

      // Check if the topic exists (for now, we'll just check if it's a valid URL)
      try {
        new URL(request.topic);
      } catch (error) {
        return {
          success: false,
          message: `Invalid topic URL: ${request.topic}`,
        };
      }

      // Check if the callback is a valid URL
      try {
        new URL(request.callback);
      } catch (error) {
        return {
          success: false,
          message: `Invalid callback URL: ${request.callback}`,
        };
      }

      // Handle unsubscribe request
      if (request.mode === "unsubscribe") {
        const subscription = await db.subscriptions.getByTopicAndCallback(
          request.topic,
          request.callback
        );

        if (!subscription) {
          return {
            success: false,
            message: "Subscription not found",
          };
        }

        // Create a verification request
        const verificationToken = crypto.randomUUID();
        const challenge = crypto.randomUUID();
        const verificationExpires = new Date();
        verificationExpires.setMinutes(verificationExpires.getMinutes() + 15); // 15 minutes

        // Update the subscription with verification info
        await db.subscriptions.update({
          ...subscription,
          verificationToken,
          verificationExpires,
        });

        // Queue the verification request
        await HubService.queueVerification({
          id: subscription.id,
          topic: request.topic,
          callback: request.callback,
          mode: "unsubscribe",
          challenge,
          verificationToken,
          expires: verificationExpires,
        });

        return {
          success: true,
          message: "Unsubscribe verification request sent",
          id: subscription.id,
        };
      }

      // Handle subscribe request
      if (request.mode === "subscribe") {
        // Check if the subscription already exists
        const existingSubscription =
          await db.subscriptions.getByTopicAndCallback(
            request.topic,
            request.callback
          );

        // Determine lease seconds
        const leaseSeconds = request.leaseSeconds || config.defaultLeaseSeconds;

        if (leaseSeconds > config.maxLeaseSeconds) {
          return {
            success: false,
            message: `Lease seconds too long, maximum is ${config.maxLeaseSeconds}`,
          };
        }

        // Create expiration date
        const expires = new Date();
        expires.setSeconds(expires.getSeconds() + leaseSeconds);

        // Create a verification token
        const verificationToken = crypto.randomUUID();
        const challenge = crypto.randomUUID();
        const verificationExpires = new Date();
        verificationExpires.setMinutes(verificationExpires.getMinutes() + 15); // 15 minutes

        let subscription: Subscription;

        if (existingSubscription) {
          // Update the existing subscription
          subscription = {
            ...existingSubscription,
            leaseSeconds,
            expires,
            verificationToken,
            verificationExpires,
            verified: false,
          };

          await db.subscriptions.update(subscription);
        } else {
          // Create a new subscription
          subscription = await db.subscriptions.create({
            topic: request.topic,
            callback: request.callback,
            secret: request.secret,
            leaseSeconds,
            created: new Date(),
            expires,
            verified: false,
            verificationToken,
            verificationExpires,
          });
        }

        // Queue the verification request
        await HubService.queueVerification({
          id: subscription.id,
          topic: request.topic,
          callback: request.callback,
          mode: "subscribe",
          leaseSeconds,
          challenge,
          verificationToken,
          expires: verificationExpires,
        });

        return {
          success: true,
          message: "Subscription verification request sent",
          id: subscription.id,
        };
      }

      return {
        success: false,
        message: `Invalid mode: ${request.mode}`,
      };
    } catch (error: unknown) {
      console.error("Error processing subscription request:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Internal server error: ${errorMessage}`,
      };
    }
  }

  // Queue a verification request
  static async queueVerification(verification: any): Promise<void> {
    // In a real implementation, we'd use Deno Deploy's queue system
    // For now, we'll just call the verification method directly
    setTimeout(() => {
      HubService.verifySubscription(verification).catch(console.error);
    }, 0);
  }

  // Verify a subscription
  static async verifySubscription(verification: any): Promise<boolean> {
    try {
      const db = await getDatabase();

      // Get the subscription
      const subscription = await db.subscriptions.getById(verification.id);

      if (!subscription) {
        console.error(`Subscription not found: ${verification.id}`);
        return false;
      }

      // Check if the verification token matches
      if (subscription.verificationToken !== verification.verificationToken) {
        console.error(
          `Verification token mismatch for subscription: ${verification.id}`
        );
        return false;
      }

      // Check if the verification has expired
      if (
        subscription.verificationExpires &&
        subscription.verificationExpires < new Date()
      ) {
        console.error(
          `Verification expired for subscription: ${verification.id}`
        );
        return false;
      }

      // Build the verification URL
      const url = new URL(verification.callback);
      url.searchParams.set("hub.mode", verification.mode);
      url.searchParams.set("hub.topic", verification.topic);
      url.searchParams.set("hub.challenge", verification.challenge);

      if (verification.mode === "subscribe" && verification.leaseSeconds) {
        url.searchParams.set(
          "hub.lease_seconds",
          verification.leaseSeconds.toString()
        );
      }

      // Send the verification request
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "User-Agent": `SuperDuperFeeder/${config.version}`,
        },
      });

      // Check the response
      if (!response.ok) {
        console.error(
          `Verification failed for subscription: ${verification.id}, status: ${response.status}`
        );

        // If unsubscribe verification fails, we still remove the subscription
        if (verification.mode === "unsubscribe") {
          await db.subscriptions.delete(verification.id);
        }

        return false;
      }

      // Check the response body
      const body = await response.text();

      if (body.trim() !== verification.challenge) {
        console.error(
          `Challenge mismatch for subscription: ${verification.id}`
        );
        return false;
      }

      // Update the subscription
      if (verification.mode === "subscribe") {
        await db.subscriptions.update({
          ...subscription,
          verified: true,
          verificationToken: undefined,
          verificationExpires: undefined,
        });
      } else if (verification.mode === "unsubscribe") {
        await db.subscriptions.delete(verification.id);
      }

      return true;
    } catch (error: unknown) {
      console.error("Error verifying subscription:", error);
      return false;
    }
  }

  // Process a publish request
  static async processPublishRequest(
    topic: string
  ): Promise<{ success: boolean; message: string; count: number }> {
    try {
      const db = await getDatabase();

      // Verify the topic URL
      try {
        new URL(topic);
      } catch (error) {
        return {
          success: false,
          message: `Invalid topic URL: ${topic}`,
          count: 0,
        };
      }

      // Prepare headers for the request
      const headers: HeadersInit = {
        "User-Agent": `SuperDuperFeeder/${config.version}`,
      };

      // Fetch the feed content directly
      const response = await fetch(topic, {
        method: "GET",
        headers,
      });

      // Check if the request was successful
      if (!response.ok) {
        return {
          success: false,
          message: `Failed to fetch topic content: HTTP error ${response.status} ${response.statusText}`,
          count: 0,
        };
      }

      // Parse the feed content
      const content = await response.text();
      let feedTitle = "";
      let feedItems: Array<{
        guid: string;
        url: string;
        title: string;
        summary: string;
        published: Date;
      }> = [];

      try {
        const parsedFeed = await parseFeed(content);
        feedTitle = parsedFeed.title?.value || "";

        // Extract items from the parsed feed
        if (parsedFeed.entries && parsedFeed.entries.length > 0) {
          feedItems = parsedFeed.entries
            .map((entry) => {
              // Get the item URL from links if available
              const url =
                entry.links && entry.links.length > 0 && entry.links[0].href
                  ? entry.links[0].href
                  : "";

              // Get the item summary from description if available
              // Note: The FeedEntry type might not have a summary property
              const summary = entry.description?.value || "";

              return {
                guid: entry.id || url || "",
                url,
                title: entry.title?.value || "Untitled",
                summary,
                published: entry.published
                  ? new Date(entry.published)
                  : entry.updated
                  ? new Date(entry.updated)
                  : new Date(),
              };
            })
            .slice(0, 10); // Limit to 10 items
        }
      } catch (parseError) {
        console.error("Error parsing feed:", parseError);
        return {
          success: false,
          message: `Failed to parse feed content: ${
            parseError instanceof Error
              ? parseError.message
              : String(parseError)
          }`,
          count: 0,
        };
      }

      // Create a notification
      const notification = {
        feed: {
          url: topic,
          title: feedTitle,
        },
        items: feedItems,
      };

      // Distribute the content to subscribers
      return await HubService.processContentNotification(
        topic,
        JSON.stringify(notification)
      );
    } catch (error: unknown) {
      console.error("Error processing publish request:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Internal server error: ${errorMessage}`,
        count: 0,
      };
    }
  }

  // Process a content notification
  static async processContentNotification(
    topic: string,
    content: string
  ): Promise<{ success: boolean; message: string; count: number }> {
    try {
      const db = await getDatabase();

      // Get all subscriptions for the topic
      const subscriptions = await db.subscriptions.getByTopic(topic);

      if (subscriptions.length === 0) {
        return {
          success: true,
          message: "No subscriptions found for topic",
          count: 0,
        };
      }

      // Queue content distribution for each subscription
      let count = 0;
      for (const subscription of subscriptions) {
        if (subscription.verified) {
          await HubService.queueDistribution(subscription, content);
          count++;
        }
      }

      return {
        success: true,
        message: `Content queued for distribution to ${count} subscribers`,
        count,
      };
    } catch (error: unknown) {
      console.error("Error processing content notification:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Internal server error: ${errorMessage}`,
        count: 0,
      };
    }
  }

  // Queue content distribution
  static async queueDistribution(
    subscription: Subscription,
    content: string
  ): Promise<void> {
    // In a real implementation, we'd use Deno Deploy's queue system
    // For now, we'll just call the distribution method directly
    setTimeout(() => {
      HubService.distributeContent(subscription, content).catch(console.error);
    }, 0);
  }

  // Distribute content to a subscriber
  static async distributeContent(
    subscription: Subscription,
    content: string
  ): Promise<boolean> {
    try {
      // Send the content to the subscriber
      const response = await fetch(subscription.callback, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `SuperDuperFeeder/${config.version}`,
          Link: `<${subscription.topic}>; rel="self", <${config.hubUrl}>; rel="hub"`,
        },
        body: content,
      });

      // Check the response
      if (!response.ok) {
        console.error(
          `Content distribution failed for subscription: ${subscription.id}, status: ${response.status}`
        );
        return false;
      }

      return true;
    } catch (error: unknown) {
      console.error("Error distributing content:", error);
      return false;
    }
  }
}
