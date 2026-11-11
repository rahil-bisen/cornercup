// Every café lives under /c/<slug>/, so the address bar already says which tenant a page belongs
// to. Deriving it once here means pages keep calling api("/api/menu") without threading a slug
// through every component.
export function cafeSlug() {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/^\/c\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Builds a link inside the current café, or `/` when the page isn't inside one.
export function cafePath(rest = "") {
  const slug = cafeSlug();
  if (!slug) return "/";
  return `/c/${encodeURIComponent(slug)}${rest}`;
}

// "/api/menu" becomes "/api/cafes/<slug>/menu". Paths that are already scoped, and the two
// deployment-wide endpoints, are left exactly as written.
function scoped(path) {
  if (!path.startsWith("/api/")) return path;

  const rest = path.slice("/api/".length);
  if (rest.startsWith("cafes/") || rest === "cafes") return path;
  if (rest === "health" || rest.startsWith("operator")) return path;

  const slug = cafeSlug();
  if (!slug) return path;

  return `/api/cafes/${encodeURIComponent(slug)}/${rest}`;
}

// The staff session is an HttpOnly cookie the browser sends by itself, so nothing here has to
// hold a token. `credentials: same-origin` makes that explicit for same-site calls.
export async function api(path, options = {}) {
  const { body, method = "GET", headers = {} } = options;

  const requestHeaders = { ...headers };
  if (body) requestHeaders["content-type"] = "application/json";

  const response = await fetch(scoped(path), {
    method,
    body,
    headers: requestHeaders,
    credentials: "same-origin",
  });
  const text = await response.text();

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const error = new Error((data && data.error) || "Something went wrong. Please try again.");
    error.status = response.status;
    error.code = data && data.code ? data.code : undefined;
    throw error;
  }

  return data;
}
