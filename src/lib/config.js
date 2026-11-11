import { useEffect, useState } from "react";
import { api, cafeSlug } from "./api.js";

// One entry per café, so browsing two clients' menus in two tabs never shows the other's name.
const pending = new Map();

export function loadSiteConfig() {
  const key = cafeSlug() || "";
  if (!pending.has(key)) {
    const request = api("/api/config").catch((err) => {
      pending.delete(key);
      throw err;
    });
    pending.set(key, request);
  }
  return pending.get(key);
}

// Called after the staff panel saves café settings, so the name, service mode and contact details
// everywhere pick up the change without the owner reloading the page.
export function refreshSiteConfig() {
  pending.delete(cafeSlug() || "");
  return loadSiteConfig();
}

// Café name comes from the server so an outlet can be renamed without a rebuild.
export function useSiteConfig(revision = 0) {
  const [config, setConfig] = useState(null);

  useEffect(() => {
    let alive = true;
    loadSiteConfig()
      .then((data) => {
        if (alive) setConfig(data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [revision]);

  return config;
}

export function cafeName(config) {
  return (config && config.cafe && config.cafe.name) || "Café";
}
