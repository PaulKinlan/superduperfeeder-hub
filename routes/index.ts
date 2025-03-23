import { Router } from "../deps.ts";
import type { Context } from "@oak/oak";
import { config } from "../config.ts";

// Import route handlers
import hubRouter from "./hub.ts";
import staticRouter from "./static.ts";

// Create the main router
const router = new Router();

// Basic routes
router.get("/", (ctx: Context) => {
  // Redirect to the UI
  ctx.response.redirect("/ui");
});

// API info endpoint
router.get("/api", (ctx: Context) => {
  ctx.response.body = {
    name: config.name,
    description: config.description,
    version: config.version,
    documentation: "See /docs for API documentation",
  };
});

// Health check endpoint
router.get("/health", (ctx: Context) => {
  ctx.response.body = { status: "ok", timestamp: new Date().toISOString() };
});

// Mount the hub router
router.use(hubRouter.routes());
router.use(hubRouter.allowedMethods());

// Mount the static router
router.use(staticRouter.routes());
router.use(staticRouter.allowedMethods());

export default router;
