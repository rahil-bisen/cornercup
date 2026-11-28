import { ensureDb } from "./db.js";
import { handleApi } from "./api.js";
import { json, withSecurityHeaders } from "./http.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (!env.DB) {
        console.error("API startup error: D1 binding is not configured.");
        return withSecurityHeaders(
          json({ error: "Starting up, please wait…", code: "STARTING_UP" }, 503)
        );
      }

      try {
        await ensureDb(env);
      } catch (err) {
        console.error("API startup error", err && err.stack ? err.stack : err);
        return withSecurityHeaders(
          json({ error: "Starting up, please wait…", code: "STARTING_UP" }, 503)
        );
      }

      try {
        return withSecurityHeaders(await handleApi(request, env, url, ctx));
      } catch (err) {
        console.error("API error", err && err.stack ? err.stack : err);
        return withSecurityHeaders(json({ error: "Something went wrong. Please try again." }, 500));
      }
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
