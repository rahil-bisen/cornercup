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

// How long one call may take before it is abandoned. Without a deadline a stalled request never
// rejects, so every caller waits on it forever and its page stays on its skeleton indefinitely.
export const DEFAULT_TIMEOUT_MS = 15000;

// The three ways a call can fail without ever getting an answer are told apart here, because the UI
// reacts differently to each: a deadline is worth retrying, a cancelled request is not a failure at
// all, and a network failure is worth explaining.
function transportError(cause, { timedOut, canceled, timeoutMs }) {
  if (timedOut) {
    const error = new Error("The café's server took too long to answer. Please try again.");
    error.name = "TimeoutError";
    error.code = "timeout";
    error.reason = "timeout";
    error.timeoutMs = timeoutMs;
    error.cause = cause;
    return error;
  }

  if (canceled) {
    const error = new Error("The request was cancelled.");
    error.name = "AbortError";
    error.code = "aborted";
    error.reason = "aborted";
    error.canceled = true;
    error.cause = cause;
    return error;
  }

  const error = new Error("Couldn't connect. Check your internet connection and try again.");
  error.name = "NetworkError";
  error.code = "network";
  error.reason = "network";
  error.cause = cause;
  return error;
}

// Wording for an error reply that carries no message of ours. A 429 is still "too many attempts", with
// the wait from Retry-After when the reply has one; anything else is a server error and stays generic.
function fallbackMessage(response) {
  if (response.status === 429) {
    const header = response.headers && typeof response.headers.get === "function" ? response.headers.get("retry-after") : null;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) {
      const minutes = Math.ceil(seconds / 60);
      return `Too many attempts. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
    }
    return "Too many attempts. Please try again in a few minutes.";
  }
  return "Something went wrong. Please try again.";
}

// The staff session is an HttpOnly cookie the browser sends by itself, so nothing here has to
// hold a token. `credentials: same-origin` makes that explicit for same-site calls.
//
// `signal` stays the caller's to own: it is folded into the deadline rather than replaced, so a page
// that abandons a request still can, and `timeoutMs: 0` opts a call out of the deadline entirely.
export async function api(path, options = {}) {
  const { body, method = "GET", headers = {}, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const requestHeaders = { ...headers };
  if (body && !(body instanceof FormData)) requestHeaders["content-type"] = "application/json";

  const controller = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

  const forwardAbort = () => controller.abort();
  const canceledByCaller = () => Boolean(signal && signal.aborted && !timedOut);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort);
  }

  try {
    // A caller that has already given up must not reach the network at all.
    if (controller.signal.aborted) throw new Error("aborted");

    const response = await fetch(scoped(path), {
      method,
      body,
      headers: requestHeaders,
      credentials: "same-origin",
      signal: controller.signal,
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
      // The app's own JSON answer is shown as it is (a wrong password, a lockout with its wait, "not set
      // up"). Only a reply that is not ours, such as an edge error page, falls back to fixed wording.
      const error = new Error((data && data.error) || fallbackMessage(response));
      error.status = response.status;
      error.code = data && data.code ? data.code : undefined;
      throw error;
    }

    return data;
  } catch (err) {
    // A reply the server did send already carries its own status and message; only a call that never
    // got an answer is reshaped into a transport error.
    if (err && err.status) throw err;
    throw transportError(err, { timedOut, canceled: canceledByCaller(), timeoutMs });
  } finally {
    // The deadline and the caller's listener must not outlive the call, or a long-lived page leaks one
    // timer and one listener per request.
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forwardAbort);
  }
}
