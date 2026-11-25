import { useCallback, useEffect, useState } from "react";
import { api, cafeSlug } from "./api.js";

// One entry per café, so browsing two clients' menus in two tabs never shows the other's name.
const pending = new Map();

export function loadSiteConfig(options) {
  const key = cafeSlug() || "";
  const cached = pending.get(key);
  if (cached) return cached;

  // The promise is shared by every caller for this café, so it must not carry one caller's abort
  // signal: that caller cancelling would cancel the request for everyone else waiting on it, and they
  // would see a "cancelled" failure they never caused. A caller that needs to withdraw a request owns
  // it directly by calling api() instead of joining the shared one. The deadline is safe to share
  // because it belongs to the request, not to a caller.
  const { signal: _sharedRequestIgnoresSignal, ...shared } = options || {};
  const request = api("/api/config", shared);
  pending.set(key, request);
  // A rejected or timed-out request must not stay cached: without this, one bad moment pins the café's
  // config to a dead promise for the rest of the session and even a retry re-uses it. Only this exact
  // request is dropped, so a newer one that already took the slot is never evicted behind its back.
  request.catch(() => {
    if (pending.get(key) === request) pending.delete(key);
  });
  return request;
}

// Called after the staff panel saves café settings, so the name, service mode and contact details
// everywhere pick up the change without the owner reloading the page.
export function refreshSiteConfig(options) {
  pending.delete(cafeSlug() || "");
  return loadSiteConfig(options);
}

// The config, plus the failure and a retry, for the screens that must not sit on a blank shell when
// the café's settings never arrive.
export function useSiteConfigState(revision = 0) {
  // Which café this page is on right now. Moving between cafés inside the app keeps the component
  // mounted, so the slug has to drive the fetch or the new café would inherit the old one's settings.
  const slug = cafeSlug() || "";
  const [state, setState] = useState({ slug, config: null, error: null });
  // Bumped only by retry(), so a second attempt is always something the guest chose — there is no
  // timer that could spin here.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    // A retry of the café already on screen keeps what it is showing; a different café starts blank,
    // because one café's name or service mode inside another's menu is exactly the bug to avoid.
    setState((current) => ({ slug, config: current.slug === slug ? current.config : null, error: null }));

    loadSiteConfig()
      .then((data) => {
        if (alive) setState({ slug, config: data, error: null });
      })
      .catch((err) => {
        // A request the caller withdrew says nothing about the café, so it is not shown as a failure.
        if (alive && !(err && err.canceled)) setState({ slug, config: null, error: err });
      });

    // The cleanup also covers the request that was still in flight when the café changed: its answer
    // can no longer land, so an older reply never overwrites the newer café's config.
    return () => {
      alive = false;
    };
  }, [slug, revision, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // The render right after a café change still holds the previous café until the effect runs, so what
  // goes out is filtered by the slug the page is actually on.
  const sameCafe = state.slug === slug;
  return { config: sameCafe ? state.config : null, error: sameCafe ? state.error : null, retry };
}

// Café name comes from the server so an outlet can be renamed without a rebuild.
export function useSiteConfig(revision = 0) {
  return useSiteConfigState(revision).config;
}

export function cafeName(config) {
  return (config && config.cafe && config.cafe.name) || "Café";
}
