// Static file routes

import { Router, join } from "../deps.ts";
import type { Context } from "@oak/oak";

const router = new Router();

// Serve static files from the ui/public directory
router.get("/ui", async (ctx: Context) => {
  await ctx.send({
    root: join(Deno.cwd(), "ui/public"),
    index: "index.html",
  });
});

router.get("/ui/:path*", async (ctx: Context) => {
  await ctx.send({
    root: join(Deno.cwd(), "ui/public"),
  });
});

// Keep the original /docs routes for backward compatibility
router.get("/docs", async (ctx: Context) => {
  await ctx.send({
    root: join(Deno.cwd(), "ui/public"),
    index: "index.html",
  });
});

router.get("/docs/:path*", async (ctx: Context) => {
  await ctx.send({
    root: join(Deno.cwd(), "ui/public"),
  });
});

export default router;
