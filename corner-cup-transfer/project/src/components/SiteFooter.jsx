import { Link } from "react-router-dom";
import { cafePath } from "../lib/api.js";
import { cafeName, useSiteConfig } from "../lib/config.js";

const LINKS = [
  ["/about", "About us"],
  ["/contact", "Contact us"],
  ["/pricing", "Pricing"],
  ["/terms", "Terms"],
  ["/privacy", "Privacy"],
  ["/refund", "Refunds"],
];

export default function SiteFooter() {
  const cafe = cafeName(useSiteConfig());

  return (
    <footer className="site-foot">
      <p className="muted small">
        {cafe} · QR ordering. No app needed, nothing charged beyond your bill.
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
