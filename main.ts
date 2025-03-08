import { Application, oakCors } from "./deps.ts";
import type { Context, Next } from "@oak/oak";
import { config } from "./config.ts";

// Import routes
import router from "./routes/index.ts";

// Import services
import { PollingService } from "./services/polling.ts";
import { FirehoseService } from "./services/firehose.ts";
import { STATUS_CODE } from "@std/http";

// Initialize the application
const app = new Application();

// Basic middleware
app.use(oakCors()); // Enable CORS
app.use(async (ctx: Context, next: Next) => {
  try {
    await next();
  } catch (err: unknown) {
    console.error(err);
    const status =
      err instanceof Error && "status" in err
        ? (err as { status: number }).status
        : STATUS_CODE.InternalServerError;

    const message =
      err instanceof Error ? err.message : "Internal Server Error";

    ctx.response.status = status;
    ctx.response.body = {
      success: false,
      message,
    };
  }
});

// Log requests
app.use(async (ctx: Context, next: Next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`${ctx.request.method} ${ctx.request.url.pathname} - ${ms}ms`);
});

// Apply router
app.use(router.routes());
app.use(router.allowedMethods());

// Start the server
const port = config.port || 8000;
console.log(`Server running on http://localhost:${port}`);

// Start the services
console.log("Starting services...");

// Start the polling service
PollingService.start().catch((error) => {
  console.error("Error starting polling service:", error);
});

// Publish a system event
FirehoseService.publishSystemEvent("Server started").catch((error) => {
  console.error("Error publishing system event:", error);
});

// Start the server
await app.listen({ port });
