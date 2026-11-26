import { Link } from "react-router-dom";
import { cafePath } from "../lib/api.js";
import { useSiteConfig } from "../lib/config.js";

const LINKS = [
  ["/about", "About us"],
  ["/contact", "Contact us"],
  ["/pricing", "Pricing"],
  ["/terms", "Terms"],
  ["/privacy", "Privacy"],
  ["/refund", "Refunds"],
];

export default function SiteFooter() {
  const config = useSiteConfig();
  // No generic "Café" stand-in: until the real name arrives the line simply goes without one.
  const cafe = config && config.cafe && config.cafe.name ? String(config.cafe.name).trim() : "";

  return (
    <footer className="site-foot">
      <p className="muted small">
        {cafe ? `${cafe} · ` : ""}QR ordering. No app needed, nothing charged beyond your bill.
      </p>
      <nav className="site-foot-links" aria-label="Site information">
        {LINKS.map(([to, label]) => (
          <Link key={to} to={cafePath(to)}>
            {label}
          </Link>
        ))}
      </nav>
    </footer>
  );
}
