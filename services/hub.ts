// WebSub hub service

import { config } from "../config.ts";
import { getDatabase } from "../utils/database.ts";
import { Subscription, SubscriptionRequest } from "../models/subscription.ts";
import { crypto, parseFeed } from "../deps.ts";
import { Feed } from "../models/feed.ts";

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
          console.log(
            "Updating existing subscription:",
            existingSubscription.id
          );
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
          console.log("Creating new subscription");
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
    console.log("Queueing verification request:", verification);
    setTimeout(() => {
      HubService.verifySubscription(verification).catch(console.error);
    }, 0);
  }

  // Check if a URL is a feed or has a link to a feed
  static async checkAndAddFeedForPolling(topic: string): Promise<{
    success: boolean;
    feedUrl: string;
    lastProcessedEntryId?: string;
  }> {
    try {
      const db = await getDatabase();

      // Check if the feed already exists in the FeedStore
      const existingFeed = await db.feeds.getByUrl(topic);
      if (existingFeed) {
        return {
          success: true,
          feedUrl: topic,
          lastProcessedEntryId: existingFeed.lastProcessedEntryId,
        };
      }

      // Prepare headers for the request
      const headers: HeadersInit = {
        "User-Agent": `SuperDuperFeeder/${config.version}`,
      };

      // Fetch the content
      const response = await fetch(topic, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        console.error(
          `Failed to fetch topic: ${topic}, status: ${response.status}`
        );
        return { success: false, feedUrl: topic };
      }

      const contentType = response.headers.get("Content-Type") || "";
      const content = await response.text();

      // Try to parse as a feed
      try {
        const parsedFeed = await parseFeed(content);

        // It's a feed! Add it to the FeedStore for polling
        let feedUrl = topic;
        let lastProcessedEntryId: string | undefined;

        // Get the most recent entry ID if available
        if (parsedFeed.entries && parsedFeed.entries.length > 0) {
          // Sort entries by updated or published date, newest first
          const sortedEntries = [...parsedFeed.entries].sort((a, b) => {
            const aDate = a.updated || a.published || "";
            const bDate = b.updated || b.published || "";
            return new Date(bDate).getTime() - new Date(aDate).getTime();
          });

          // Use the ID of the most recent entry
          lastProcessedEntryId =
            sortedEntries[0].id ||
            sortedEntries[0].links?.[0]?.href ||
            undefined;
        }

        // Extract title and description safely
        let feedTitle: string | undefined;
        let feedDescription: string | undefined;

        try {
          feedTitle = parsedFeed.title?.toString() || undefined;
        } catch (e) {
          console.error("Error extracting feed title:", e);
        }

        try {
          feedDescription = parsedFeed.description?.toString() || undefined;
        } catch (e) {
          console.error("Error extracting feed description:", e);
        }

        // Create the feed in the FeedStore
        const feed: Omit<Feed, "id" | "errorCount"> = {
          url: feedUrl,
          title: feedTitle,
          description: feedDescription,
          pollingInterval: config.defaultPollingIntervalMinutes || 60, // Default to 60 minutes if not configured
          active: true,
          supportsWebSub: false, // We're here because WebSub verification failed
          lastProcessedEntryId,
        };

        await db.feeds.create(feed);

        console.log(`Added feed to polling: ${feedUrl}`);
        return {
          success: true,
          feedUrl,
          lastProcessedEntryId,
        };
      } catch (parseError) {
        // Not a feed, check if it's an HTML page with a feed link
        if (contentType.includes("text/html")) {
          // Simple regex to find feed links
          const feedLinkRegex =
            /<link[^>]+rel=["'](?:alternate|feed)["'][^>]+href=["']([^"']+)["'][^>]*>/i;
          const match = content.match(feedLinkRegex);

          if (match && match[1]) {
            let feedUrl = match[1];

            // Handle relative URLs
            if (feedUrl.startsWith("/") || !feedUrl.startsWith("http")) {
              const baseUrl = new URL(topic);
              feedUrl = new URL(feedUrl, baseUrl.origin).toString();
            }

            // Recursively check the feed URL
            return await HubService.checkAndAddFeedForPolling(feedUrl);
          }
        }
      }

      return { success: false, feedUrl: topic };
    } catch (error) {
      console.error(`Error checking feed: ${topic}`, error);
      return { success: false, feedUrl: topic };
    }
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

      console.log(
        `Verifying subscription: ${verification.id}, mode: ${verification.mode}`
      );

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

      console.log(`Sending Verification URL: ${url.toString()}`);
      // Send the verification request
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "User-Agent": `SuperDuperFeeder/${config.version}`,
        },
      });

      // Check the response
      if (!response.ok || response.status >= 400) {
        console.error(
          `Verification failed for subscription: ${verification.id}, status: ${response.status}`
        );

        // If unsubscribe verification fails, we still remove the subscription
        if (verification.mode === "unsubscribe") {
          await db.subscriptions.delete(verification.id);
        } else if (verification.mode === "subscribe") {
          // For subscribe failures, check if it's a feed and add it for polling
          console.log(`Checking if topic is a feed: ${verification.topic}`);
          const feedCheck = await HubService.checkAndAddFeedForPolling(
            verification.topic
          );
          if (feedCheck.success) {
            console.log(`Added topic to polling: ${feedCheck.feedUrl}`);
            // Update the subscription to mark it as verified since we'll handle it via polling
            await db.subscriptions.update({
              ...subscription,
              verified: true,
              verificationToken: undefined,
              verificationExpires: undefined,
            });
            return true;
          }
        }

        return false;
      }

      // Check the response body
      const body = await response.text();

      if (body.trim() !== verification.challenge) {
        console.error(
          `Challenge mismatch for subscription: ${verification.id}`
        );

        // If challenge mismatch for subscribe, check if it's a feed and add it for polling
        if (verification.mode === "subscribe") {
          console.log(
            `Challenge mismatch, checking if topic is a feed: ${verification.topic}`
          );
          const feedCheck = await HubService.checkAndAddFeedForPolling(
            verification.topic
          );

          if (feedCheck.success) {
            console.log(`Added topic to polling: ${feedCheck.feedUrl}`);

            // Update the subscription to mark it as verified since we'll handle it via polling
            await db.subscriptions.update({
              ...subscription,
              verified: true,
              verificationToken: undefined,
              verificationExpires: undefined,
            });

            return true;
          }
        }

        return false;
      }

      console.log(`Subscription verified: ${verification.id}`);

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

      const feedCheck = await HubService.checkAndAddFeedForPolling(
        verification.topic
      );

      if (feedCheck.success) {
        console.log(`Added topic to polling: ${feedCheck.feedUrl}`);
        return true;
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
      const contentType = response.headers.get("Content-Type") || "text/plain";

      // Distribute the content to subscribers
      return await HubService.processContentNotification(
        topic,
        content,
        contentType
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
    content: string,
    contentType: string
  ): Promise<{ success: boolean; message: string; count: number }> {
    try {
      const db = await getDatabase();

      // Get all subscriptions for the topic
      const subscriptions = await db.subscriptions.getByTopic(topic);

      if (subscriptions.length === 0) {
        console.log(`No subscriptions found for topic: ${topic}`);
        return {
          success: true,
          message: "No subscriptions found for topic",
          count: 0,
        };
      }

      console.log(
        `Distributing content to ${subscriptions.length} subscribers`
      );

      // Queue content distribution for each subscription
      let count = 0;
      for (const subscription of subscriptions) {
        if (subscription.verified) {
          await db.queue.enqueue({
            type: "contentDistribution",
            subscription,
            feedUrl: topic,
            content,
            contentType,
          });

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

  // Distribute content to a subscriber
  static async distributeContent(
    subscription: Subscription,
    content: string,
    contentType: string
  ): Promise<boolean> {
    try {
      // Send the content to the subscriber
      const response = await fetch(subscription.callback, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "User-Agent": `SuperDuperFeeder/${config.version}`,
          Link: `<${subscription.topic}>; rel="self", <${config.hubUrl}/>; rel="hub"`,
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
