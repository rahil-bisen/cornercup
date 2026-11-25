import { ensureDb } from "./db.js";
import { handleApi } from "./api.js";
import { json, withSecurityHeaders } from "./http.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        await ensureDb(env);
        return withSecurityHeaders(await handleApi(request, env, url, ctx));
      } catch (err) {
        console.error("API error", err && err.stack ? err.stack : err);
        return withSecurityHeaders(json({ error: "Something went wrong. Please try again." }, 500));
      }
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
