import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import QRCode from "qrcode";
import { api, cafePath, cafeSlug } from "../lib/api.js";
import { cafeName, isCafeNotFound, refreshSiteConfig, useSiteConfigState } from "../lib/config.js";
import CafeNotFound from "../components/CafeNotFound.jsx";
import { clockTime, money, timeAgo } from "../lib/money.js";
import { gatewayEnabled } from "../lib/payments.js";
import DietMark from "../components/DietMark.jsx";
import { placeholderInitial } from "../lib/menuImages.js";

const WARM_MINUTES = 10;
const LATE_MINUTES = 20;

// The board polls for new tickets while someone is looking at it. Ten seconds keeps a fresh order
// visible quickly without turning every idle screen into a request every four seconds; both the
// request budget and the API rate limiter are documented in RATE_LIMIT_CAPACITY_REPORT.md.
const BOARD_POLL_MS = 10 * 1000;

export default function Admin() {
  const [session, setSession] = useState("checking");
  // The board cannot read its HttpOnly cookie, so the server hands it a CSRF token that proves a
  // sign-out-everywhere request really came from this page and not from another site.
  const [csrfToken, setCsrfToken] = useState("");
  // Bumped after a settings save so the header picks up a renamed café without a page reload.
  const [revision, setRevision] = useState(0);
  const { config, error: configError } = useSiteConfigState(revision);
  // Empty until the config arrives: the header shows a loading bar instead of the generic "Café".
  const cafe = config ? cafeName(config) : "";

  // The session is an HttpOnly cookie, so the page cannot see it — it has to ask the server once
  // on load instead of reading a token out of storage.
  useEffect(() => {
    let alive = true;
    localStorage.removeItem("admin_token");
    api("/api/admin/session")
      .then((payload) => {
        if (!alive) return;
        setCsrfToken(payload && payload.csrfToken ? payload.csrfToken : "");
        setSession("in");
      })
      .catch(() => {
        if (alive) setSession("out");
      });
    return () => {
      alive = false;
    };
  }, []);

  // Sliding expiry: the status call renews the session row and reissues this browser's cookie in the
  // same response, so a board left open through a long shift keeps working. Ten minutes is frequent
  // enough that the session never drifts near its twelve-hour limit while the screen is open.
  useEffect(() => {
    if (session !== "in") return undefined;
    const timer = setInterval(async () => {
      try {
        const payload = await api("/api/admin/session");
        setCsrfToken(payload && payload.csrfToken ? payload.csrfToken : "");
      } catch {
        // The session was revoked or expired: drop back to sign-in instead of polling a dead session.
        setSession("out");
      }
    }, 10 * 60 * 1000);
    return () => clearInterval(timer);
  }, [session]);

  // Ordinary sign-out ends this browser only: the server deletes this session's row, so a copied cookie
  // stops working here while every other device keeps its own session. Ending the other devices is a
  // separate, confirmed action.
  const signOut = useCallback(async () => {
    try {
      await api("/api/admin/logout", { method: "POST" });
    } catch {
      /* clearing the screen matters more than the request succeeding */
    }
    setSession("out");
  }, []);

  // Bumps the café's auth version, which kills every session on every device, and the server
  // reissues this browser's cookie in the same response so the board keeps working here.
  const signOutEverywhere = useCallback(async () => {
    const confirmed = window.confirm(
      "Sign out everywhere?\n\nEvery phone, tablet and computer signed into this café's board will be signed out. " +
        "This screen stays signed in."
    );
    if (!confirmed) return;
    try {
      await api("/api/admin/logout-all", { method: "POST", headers: { "x-csrf-token": csrfToken } });
      // The replacement cookie is a different session, so the CSRF token bound to the old one is
      // spent; without this refresh a second sign-out-everywhere would be refused until a reload.
      const payload = await api("/api/admin/session");
      setCsrfToken(payload && payload.csrfToken ? payload.csrfToken : "");
    } catch (err) {
      window.alert(err && err.message ? err.message : "We couldn't sign the other devices out.");
    }
  }, [csrfToken]);

  // A fresh sign-in sets the cookie, but the board still needs the CSRF token that guards
  // "sign out everywhere". This is the same call the mount effect makes, run once after login so the
  // action is not refused until the next reload.
  const startSession = useCallback(async () => {
    try {
      const payload = await api("/api/admin/session");
      setCsrfToken(payload && payload.csrfToken ? payload.csrfToken : "");
    } catch {
      /* the board still opens; a revocation attempt will report its own refusal */
    }
    setSession("in");
  }, []);

  // The board owns the tab title while it is open; the sign-in screens must not inherit the guest
  // menu's title from the page the owner arrived from.
  useEffect(() => {
    if (session === "in") return undefined;
    document.title = cafe ? `Owner sign in · ${cafe}` : "Owner sign in";
  }, [session, cafe]);

  // No café lives at this address, so there is no board to sign in to.
  if (isCafeNotFound(configError)) return <CafeNotFound />;

  if (session === "checking") {
    return (
      <main className="login-wrap">
        <p className="muted small">Checking your session…</p>
      </main>
    );
  }

  if (session === "out") {
    return <AdminLogin onSignIn={startSession} ownerAuth={config && config.ownerAuth} />;
  }
  return (
    <AdminShell
      onSignOut={signOut}
      onSignOutEverywhere={signOutEverywhere}
      csrfToken={csrfToken}
      cafe={cafe}
      payments={config && config.payments}
      serviceMode={config && config.service ? config.service.mode : null}
      onSettingsSaved={async () => {
        await refreshSiteConfig();
        setRevision((value) => value + 1);
      }}
    />
  );
}

function AdminLogin({ onSignIn, ownerAuth }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Step two of a two-factor sign-in. A challenge, not the password, is what the code is submitted
  // with, and it is single-use server-side.
  const [challenge, setChallenge] = useState("");
  const [totpCode, setTotpCode] = useState("");
  // A managed café has exactly one way in, so the password form is never rendered for it. The mode is
  // a public label from /api/config; no identity or token reaches this page.
  const managed = ownerAuth === "workos";
  const signedOut = new URLSearchParams(window.location.search).get("signed_out") === "1";
  // An invite arrives in the fragment, which the browser never sends to the server, so a code in a
  // link cannot end up in an access log or a Referer.
  const [claimCode, setClaimCode] = useState(() => {
    const fragment = String(window.location.hash || "").replace(/^#/, "");
    return new URLSearchParams(fragment).get("claim") || "";
  });
  const [claimBusy, setClaimBusy] = useState(false);

  const submitClaim = async (event) => {
    event.preventDefault();
    setClaimBusy(true);
    setError("");
    try {
      const payload = await api(`/api/cafes/${cafeSlug()}/owner/claim/start`, {
        method: "POST",
        body: JSON.stringify({ code: claimCode }),
      });
      // A top-level navigation is the only way to reach the provider: the authorize URL is a page,
      // not an API call the board could follow with fetch.
      window.location.assign(payload.authorizeUrl);
    } catch (err) {
      setError(err.message);
    } finally {
      setClaimBusy(false);
    }
  };

  if (managed) {
    return (
      <main className="login-wrap">
        <div className="login-card">
          <span className="brand-mark" aria-hidden="true">
            ☕
          </span>
          <h1>Owner sign in</h1>
          <p className="muted small">
            This café signs in with a managed identity. You'll be sent to your identity provider and
            brought straight back.
          </p>
          {signedOut && <p className="muted small">You've been signed out.</p>}
          <button
            type="button"
            className="btn primary"
            onClick={() => window.location.assign(`/api/cafes/${cafeSlug()}/owner/start`)}
          >
            Continue to sign in
          </button>
          <form onSubmit={submitClaim}>
            <label className="field">
              <span>First time here? Paste your invite code</span>
              <input
                value={claimCode}
                onChange={(event) => setClaimCode(event.target.value)}
                placeholder="Invite code from your operator"
                autoComplete="one-time-code"
              />
            </label>
            <button type="submit" className="btn" disabled={claimBusy || claimCode.length === 0}>
              {claimBusy ? "Checking…" : "Redeem invite"}
            </button>
          </form>
          {error && <p className="alert" role="alert">{error}</p>}
          <Link className="muted small center" to={cafePath("")}>
            Back to the café site
          </Link>
        </div>
      </main>
    );
  }

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const step = challenge
        ? await api("/api/admin/login/totp", {
            method: "POST",
            body: JSON.stringify({ challenge, code: totpCode }),
          })
        : await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: pin }) });
      if (step && step.mfaRequired) {
        // The password was right and the account has an authenticator: no session exists yet.
        setChallenge(step.challenge || "");
        setTotpCode("");
        setPin("");
        return;
      }
      onSignIn();
    } catch (err) {
      setError(err.message);
      // A rejected code restarts from the password: the challenge is spent either way on success and
      // the rate limit is the backstop on repeated failures.
      if (challenge) setChallenge("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <span className="brand-mark" aria-hidden="true">
          ☕
        </span>
        <h1>Owner sign in</h1>
        <p className="muted small">
          {challenge
            ? "Enter the 6-digit code from your authenticator app, or one recovery code."
            : "Enter the owner password to open the order board."}
        </p>
        {signedOut && <p className="muted small">You've been signed out.</p>}
        {challenge ? (
          <label className="field">
            <span>Authenticator code</span>
            <input
              className="pin-input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totpCode}
              onChange={(event) => setTotpCode(event.target.value)}
              placeholder="123 456"
              autoFocus
            />
          </label>
        ) : (
          <label className="field">
            <span>Password</span>
            <input
              className="pin-input"
              type="password"
              autoComplete="current-password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              autoFocus
            />
          </label>
        )}
        {error && <p className="alert" role="alert">{error}</p>}
        <button
          type="submit"
          className="btn primary"
          disabled={busy || (challenge ? totpCode.trim().length < 6 : pin.length === 0)}
        >
          {busy ? "Checking…" : challenge ? "Verify code" : "Open the board"}
        </button>
        <Link className="muted small center" to={cafePath("")}>
          Back to the café site
        </Link>
      </form>
    </main>
  );
}

// Staff need to know whether the gateway is actually live: without keys the rail deliberately falls
// back to counter payments instead of showing a guest a pay button that would fail.
function paymentMode(payments) {
  if (!payments) return "loading…";
  return gatewayEnabled({ payments }) ? "Razorpay checkout on" : "Guests pay at the counter";
}

function AdminShell({ onSignOut, onSignOutEverywhere, csrfToken, cafe, payments, serviceMode, onSettingsSaved }) {
  // A pickup café has one code for the whole café instead of one per table.
  const counterService = serviceMode === "counter";
  const [tab, setTab] = useState("orders");
  // A pickup café has no tables, so it has no Tables & QR tab at all; a Counter QR code tab takes its place.
  // The list follows the saved service mode, so a mode change in Café setup updates it without a reload.
  const tabs = [
    ["orders", "Orders"],
    ["menu", "Menu"],
    counterService ? ["counter-qr", "Counter QR code"] : ["tables", "Tables & QR"],
    ["settings", "Café setup"],
    ["security", "Security"],
  ];
  // If the tab on screen no longer exists (Tables & QR after a switch to counter service, or the reverse),
  // show Orders.
  const activeTab = tabs.some(([key]) => key === tab) ? tab : "orders";

  const call = useCallback(
    async (path, options = {}) => {
      // Every state-changing call carries the CSRF token the session endpoint issued. The server
      // requires it on every owner mutation, so centralising it here is what keeps the board honest.
      const method = String((options && options.method) || "GET").toUpperCase();
      const request =
        method === "GET" || method === "HEAD"
          ? options
          : { ...options, headers: { ...(options.headers || {}), "x-csrf-token": csrfToken } };
      try {
        return await api(path, request);
      } catch (err) {
        // A rejected current password is a 401 too, but the session is fine — signing out here would
        // hide the message and log the owner out for a typo. Only a real session failure signs out.
        if (err.status === 401 && err.code !== "reauth_required") onSignOut();
        throw err;
      }
    },
    [onSignOut, csrfToken]
  );

  return (
    <div className="admin">
      <header className="admin-top">
        <div className="admin-brand">
          <span className="brand-mark small" aria-hidden="true">
            ☕
          </span>
          <div>
            {cafe ? (
              <strong>{cafe}</strong>
            ) : (
              // The name is still on its way: a neutral bar instead of the generic "Café" placeholder.
              <strong className="admin-brand-loading" aria-busy="true">
                <span className="skeleton-line" aria-hidden="true" />
                <span className="sr-only">Loading</span>
              </strong>
            )}
            <p className="muted small">Staff screen · {paymentMode(payments)}</p>
          </div>
        </div>
        <div className="admin-top-actions">
          <Link className="btn ghost small-btn" to={cafePath("")}>
            View menu
          </Link>
          <button
            type="button"
            className="btn ghost small-btn"
            onClick={onSignOut}
            title="Signs out this browser only. Other devices stay signed in until their session expires."
          >
            Sign out
          </button>
          <button
            type="button"
            className="btn ghost small-btn"
            onClick={onSignOutEverywhere}
            title="Signs out every device, then keeps this browser signed in."
          >
            Sign out everywhere
          </button>
        </div>
      </header>

      <nav className="admin-tabs" aria-label="Staff sections">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`admin-tab${activeTab === key ? " active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="admin-body">
        {activeTab === "orders" && (
          <OrdersTab call={call} cafe={cafe} counterOnly={Boolean(payments) && !gatewayEnabled({ payments })} />
        )}
        {activeTab === "menu" && <MenuTab call={call} csrfToken={csrfToken} />}
        {activeTab === "tables" && <TablesTab call={call} />}
        {activeTab === "counter-qr" && <CounterQrCard cafe={cafe} />}
        {activeTab === "settings" && <SettingsTab call={call} onSaved={onSettingsSaved} />}
        {activeTab === "security" && <SecurityTab call={call} onSignOut={onSignOut} />}
      </div>
    </div>
  );
}

// counterOnly: the café takes no online payment, so every order arrives unpaid and is paid at the counter
// later. Such a board shows and announces every order; the paid-first split only makes sense with a
// gateway, where an unpaid ticket means the guest has not paid yet and the kitchen should wait.
function OrdersTab({ call, cafe, counterOnly = false }) {
  const [orders, setOrders] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [view, setView] = useState("paid");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [arrived, setArrived] = useState([]);
  const [sound, setSound] = useState(() => localStorage.getItem("board_sound") === "on");
  const seen = useRef(null);
  const audio = useRef(null);
  const soundRef = useRef(sound);

  soundRef.current = sound;
  const counterOnlyRef = useRef(counterOnly);
  counterOnlyRef.current = counterOnly;

  // Two rising notes, built on the fly so the board ships no audio file. A blocked AudioContext
  // is not worth an error: the visual alert still lands.
  const beep = useCallback(() => {
    if (!soundRef.current) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      audio.current = audio.current || new AudioCtx();
      const ctx = audio.current;
      const note = (start, frequency) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.5);
      };
      note(ctx.currentTime, 880);
      note(ctx.currentTime + 0.18, 1180);
    } catch {
      /* no sound, no problem */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const payload = await call("/api/admin/orders");
      const next = payload.orders || [];
      setOrders(next);
      setStats(payload.statistics || null);
      setError("");

      // Anything that became a paid ticket since the previous poll is worth a nod — staff are not
      // staring at this screen, they are making coffee.
      if (seen.current) {
        const fresh = next.filter(
          (order) =>
            !seen.current.has(order.id) &&
            (counterOnlyRef.current ||
              order.paymentStatus === "confirmed" ||
              order.paymentStatus === "counter")
        );
        if (fresh.length) {
          setArrived(fresh.map((order) => order.id));
          beep();
        }
      }
      seen.current = new Set(next.map((order) => order.id));
    } catch (err) {
      setError(err.message);
    }
  }, [call, beep]);

  // Polling stops while the screen is hidden (a background tab, a phone in a pocket) and refreshes
  // immediately when it comes back, so a forgotten tab costs nothing and returning staff never wait
  // for the next tick.
  useEffect(() => {
    load();
    let timer = null;
    const start = () => {
      if (timer === null) timer = setInterval(load, BOARD_POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        load();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  useEffect(() => {
    if (!arrived.length) return;
    const timer = setTimeout(() => setArrived([]), 30000);
    return () => clearTimeout(timer);
  }, [arrived]);

  const openNow = (orders || []).filter(
    (order) => order.status === "new" || order.status === "preparing" || order.status === "ready"
  ).length;

  // The tab title is the only part of this screen visible when the phone is in a pocket.
  useEffect(() => {
    // Until the café's name is known the title leaves it out rather than showing a placeholder.
    const suffix = cafe ? ` · ${cafe}` : "";
    document.title = openNow ? `(${openNow}) Orders${suffix}` : `Staff${suffix}`;
    return () => {
      document.title = cafe || "Staff";
    };
  }, [openNow, cafe]);

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    localStorage.setItem("board_sound", next ? "on" : "off");
    if (!next) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        audio.current = audio.current || new AudioCtx();
        audio.current.resume().catch(() => {});
      }
    } catch {
      /* ignore */
    }
    beep();
  };

  const setStatus = async (id, status) => {
    setBusy(id);
    try {
      await call(`/api/admin/orders/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const setPayment = async (id, paymentStatus) => {
    setBusy(id);
    try {
      await call(`/api/admin/orders/${id}`, { method: "PATCH", body: JSON.stringify({ paymentStatus }) });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const cancelOrder = async (id) => {
    if (!window.confirm(`Cancel order #${id}? The guest will see it was cancelled by the café.`)) return;
    await setStatus(id, "cancelled");
  };

  const columns = [
    { key: "new", title: "New", action: "Preparing", next: "preparing" },
    { key: "preparing", title: "Preparing", action: "Ready", next: "ready" },
    { key: "ready", title: "Ready", action: "Served", next: "served" },
  ];

  const matches = (order) => {
    const term = query.trim().toLowerCase();
    if (!term) return true;
    return (
      String(order.id).toLowerCase().includes(term) ||
      String(order.tableLabel || "").toLowerCase().includes(term) ||
      (order.queueNo != null && String(order.queueNo).includes(term)) ||
      (order.items || []).some((item) => String(item.name).toLowerCase().includes(term))
    );
  };

  if (!orders) {
    return <p className="muted">Loading the board…</p>;
  }

  // This is the owner's money screen: paid orders first, everything unsettled behind the second tab.
  const settled = (order) => order.paymentStatus === "confirmed" || order.paymentStatus === "counter";
  const byPayment = counterOnly
    ? orders
    : view === "paid"
      ? orders.filter(settled)
      : orders.filter((order) => !settled(order));
  const visible = byPayment.filter(matches);
  const open = visible.filter((order) => columns.some((column) => column.key === order.status));
  const done = visible.filter((order) => order.status === "served" || order.status === "cancelled");

  const ageOf = (order) => Math.max(0, Math.round((Date.now() - new Date(order.createdAt).getTime()) / 60000));
  const ageTone = (order, minutes) => {
    if (order.status === "served" || order.status === "cancelled") return "";
    if (minutes >= LATE_MINUTES) return " late";
    if (minutes >= WARM_MINUTES) return " warm";
    return "";
  };

  return (
    <section>
      <div className="board-head-row">
        <h1>{counterOnly ? "Orders" : view === "paid" ? "Paid orders" : "Unpaid / failed"}</h1>
        {arrived.length > 0 && (
          <button type="button" className="new-pill" onClick={() => setArrived([])}>
            {arrived.length} new {arrived.length === 1 ? "order" : "orders"} · tap to clear
          </button>
        )}
        <p className="muted small">Live · refreshes every {BOARD_POLL_MS / 1000}s · {open.length} open</p>
      </div>

      {stats && (
        <div className="stat-strip">
          <div className="stat">
            <span>Collected today</span>
            <strong>{money(stats.collectedCents)}</strong>
            <em>
              {stats.settledOrders} paid {stats.settledOrders === 1 ? "order" : "orders"}
            </em>
          </div>
          <div className="stat">
            <span>Online</span>
            <strong>{money(stats.onlineCents)}</strong>
            <em>Razorpay</em>
          </div>
          <div className="stat">
            <span>At the counter</span>
            <strong>{money(stats.counterCents)}</strong>
            <em>marked by staff</em>
          </div>
          <div className={`stat${stats.pendingCents ? " warn" : ""}`}>
            <span>Unpaid today</span>
            <strong>{money(stats.pendingCents)}</strong>
            <em>{stats.openOrders} open now</em>
          </div>
          <div className="stat">
            <span>Average bill</span>
            <strong>{money(stats.averageCents)}</strong>
            <em>
              {stats.orders} {stats.orders === 1 ? "order" : "orders"} today
            </em>
          </div>
        </div>
      )}

      <div className="board-tools">
        <input
          className="board-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search order number, table or item"
          aria-label="Search orders"
        />
        <button
          type="button"
          className={`sound-btn${sound ? " on" : ""}`}
          onClick={toggleSound}
          aria-pressed={sound}
        >
          {sound ? "🔔 Sound on" : "🔕 Sound off"}
        </button>
      </div>

      {!counterOnly && (
      <div className="owner-tabs" role="tablist" aria-label="Filter orders by payment">
        <button
          type="button"
          role="tab"
          aria-selected={view === "paid"}
          className={view === "paid" ? "active" : ""}
          onClick={() => setView("paid")}
        >
          Paid
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "unpaid"}
          className={view === "unpaid" ? "active" : ""}
          onClick={() => setView("unpaid")}
        >
          Unpaid / failed
        </button>
      </div>
      )}

      {error && <p className="alert" role="alert">{error}</p>}

      <div className="board">
        {columns.map((column) => {
          const items = open.filter((order) => order.status === column.key);
          return (
            <div key={column.key} className={`board-col ${column.key}`}>
              <header>
                <h2>{column.title}</h2>
                <span className="count">{items.length}</span>
              </header>
              {items.length === 0 && (
                <p className="empty muted small">{query ? "Nothing matches that search." : "Nothing here yet."}</p>
              )}
              {items.map((order) => {
                const minutes = ageOf(order);
                return (
                  <article key={order.id} className={`order-card${arrived.includes(order.id) ? " is-new" : ""}`}>
                    <div className="order-card-head">
                      <div>
                        <p className="order-table">
                          {order.queueNo != null ? `#${order.queueNo}` : order.tableLabel}
                        </p>
                        <p className="order-id">#{order.id}</p>
                        {(order.paymentTxn || order.paymentRef) && (
                          <p className="order-id">{order.paymentTxn || order.paymentRef}</p>
                        )}
                      </div>
                      <div className="order-time">
                        <span className={`order-meta${ageTone(order, minutes)}`}>{timeAgo(order.createdAt)}</span>
                        {settled(order) && order.paidAt && (
                          <span className="order-id">paid {clockTime(order.paidAt)}</span>
                        )}
                      </div>
                    </div>
                    <ul className="order-items">
                      {order.items.map((item, index) => (
                        <li key={`${order.id}-${index}`}>
                          <span className="qty">{item.qty}×</span>
                          <span>
                            {item.name}
                            {item.note && <span className="order-item-note">“{item.note}”</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {order.note && <p className="order-note">“{order.note}”</p>}
                    <div className="order-pay">
                      <PaymentChip order={order} />
                      {order.paymentStatus === "submitted" && (
                        <button
                          type="button"
                          className="btn ghost small-btn"
                          disabled={busy === order.id}
                          onClick={() => setPayment(order.id, "confirmed")}
                        >
                          Confirm payment
                        </button>
                      )}
                      {(order.paymentStatus === "unpaid" || order.paymentStatus === "failed") && (
                        <button
                          type="button"
                          className="btn ghost small-btn"
                          disabled={busy === order.id}
                          onClick={() => setPayment(order.id, "counter")}
                        >
                          Payment received
                        </button>
                      )}
                    </div>
                    <div className="order-actions">
                      <button
                        type="button"
                        className="btn primary small-btn"
                        disabled={busy === order.id}
                        onClick={() => setStatus(order.id, column.next)}
                      >
                        {column.action}
                      </button>
                      <button
                        type="button"
                        className="btn ghost small-btn danger"
                        disabled={busy === order.id}
                        onClick={() => cancelOrder(order.id)}
                      >
                        Cancel
                      </button>
                      <span className="order-total">{money(order.totalCents)}</span>
                    </div>
                  </article>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="done-block">
        <button type="button" className="link-btn" onClick={() => setShowDone((value) => !value)}>
          {showDone ? "Hide" : "Show"} completed ({done.length})
        </button>
        {showDone && (
          <ul className="done-list">
            {done.map((order) => (
              <li key={order.id} className={order.status}>
                <span className="done-table">
                  {order.queueNo != null ? `#${order.queueNo}` : order.tableLabel}
                </span>
                <span className="muted small">
                  #{order.id} · {order.items.reduce((sum, item) => sum + item.qty, 0)} items ·{" "}
                  {money(order.totalCents)}
                </span>
                <span className={`badge ${order.status}`}>{order.status}</span>
              </li>
            ))}
            {done.length === 0 && <li className="muted small">Nothing completed yet.</li>}
          </ul>
        )}
      </div>
    </section>
  );
}

function PaymentChip({ order }) {
  const labels = {
    unpaid: ["Unpaid", "unpaid"],
    submitted: ["Awaiting confirmation", "pending"],
    confirmed: ["Paid · Razorpay", "paid"],
    counter: ["Paid at counter", "counter"],
    failed: ["Payment failed", "unpaid"],
  };
  const [label, tone] = labels[order.paymentStatus] || labels.unpaid;

  return (
    <span className={`pay-chip ${tone}`}>
      {label} · {money(order.totalCents)}
    </span>
  );
}

// A new outlet is configured here instead of by editing Worker variables and redeploying: the name,
// whether the café has tables, its clock, and the contact details the policy pages quote.
const BASE_OFFSETS = [
  { value: 330, label: "India — IST (UTC+5:30)" },
  { value: 0, label: "UTC" },
  { value: 60, label: "Central Europe (UTC+1)" },
  { value: 240, label: "Gulf (UTC+4)" },
  { value: 480, label: "Singapore (UTC+8)" },
  { value: -300, label: "US Eastern (UTC−5)" },
  { value: -480, label: "US Pacific (UTC−8)" },
];

function offsetLabel(minutes) {
  const value = Number(minutes);
  const sign = value < 0 ? "−" : "+";
  const abs = Math.abs(value);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return `Current (UTC${sign}${hours}${rest ? `:${String(rest).padStart(2, "0")}` : ""})`;
}

function SettingsTab({ call, onSaved }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    call("/api/admin/settings")
      .then((payload) => {
        if (alive) setForm({ ...payload.settings, password: "", currentPassword: "" });
      })
      .catch((err) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [call]);

  const update = (key, value) => {
    setSaved(false);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = await call("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          cafeName: form.cafeName,
          serviceMode: form.serviceMode,
          tzOffsetMin: Number(form.tzOffsetMin),
          contactPhone: form.contactPhone,
          contactEmail: form.contactEmail,
          contactAddress: form.contactAddress,
          typicalWaitMin: form.typicalWaitMin === "" ? 0 : Number(form.typicalWaitMin),
          // The current password is required by the server whenever a new one is sent, so a session
          // alone cannot change the credential.
          ...(form.password
            ? { password: form.password, currentPassword: form.currentPassword || "" }
            : {}),
        }),
      });
      setForm({ ...payload.settings, password: "", currentPassword: "" });
      setSaved(true);
      if (onSaved) await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!form) return <p className="muted">{error || "Loading café settings…"}</p>;

  const offset = Number(form.tzOffsetMin);
  const offsets = BASE_OFFSETS.some((option) => option.value === offset)
    ? BASE_OFFSETS
    : [...BASE_OFFSETS, { value: offset, label: offsetLabel(offset) }].sort((a, b) => a.value - b.value);

  return (
    <section>
      <div className="board-head-row">
        <h1>Café setup</h1>
        <p className="muted small">One outlet, configured without touching code</p>
      </div>

      <form className="add-form" onSubmit={save}>
        <div className="add-grid">
          <label className="field">
            <span>Café name</span>
            <input
              required
              maxLength={60}
              value={form.cafeName}
              onChange={(event) => update("cafeName", event.target.value)}
              placeholder="Corner Cup Café"
            />
          </label>
          <label className="field">
            <span>Service style</span>
            <select value={form.serviceMode} onChange={(event) => update("serviceMode", event.target.value)}>
              <option value="tables">Table service — guests scan a table QR</option>
              <option value="counter">Counter — pickup numbers, no tables</option>
            </select>
          </label>
          <label className="field">
            <span>Café clock</span>
            <select value={offset} onChange={(event) => update("tzOffsetMin", Number(event.target.value))}>
              {offsets.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="add-grid">
          <label className="field">
            <span>Phone</span>
            <input
              maxLength={32}
              value={form.contactPhone}
              onChange={(event) => update("contactPhone", event.target.value)}
              placeholder="+91 98765 43210"
            />
          </label>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              maxLength={120}
              value={form.contactEmail}
              onChange={(event) => update("contactEmail", event.target.value)}
              placeholder="hello@cornercup.in"
            />
          </label>
        </div>

        <label className="field">
          <span>Address</span>
          <input
            maxLength={200}
            value={form.contactAddress}
            onChange={(event) => update("contactAddress", event.target.value)}
            placeholder="12 Residency Road, Bengaluru 560025"
          />
        </label>

        <label className="field">
          <span>Usual wait for an order (minutes)</span>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            max="120"
            step="1"
            value={form.typicalWaitMin ?? 0}
            onChange={(event) => update("typicalWaitMin", event.target.value)}
            aria-describedby="typical-wait-help"
          />
          <small id="typical-wait-help" className="muted small">
            Guests see &ldquo;usually ready in about this long&rdquo; while they wait. Leave at 0 to show no estimate.
          </small>
        </label>

        <label className="field">
          <span>Change owner password</span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={100}
            value={form.password || ""}
            onChange={(event) => update("password", event.target.value)}
            placeholder="Leave blank to keep the current password"
          />
        </label>

        {form.password ? (
          <label className="field">
            <span>Current owner password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={form.currentPassword || ""}
              onChange={(event) => update("currentPassword", event.target.value)}
              placeholder="Required to change the password"
            />
          </label>
        ) : null}

        {error && <p className="alert" role="alert">{error}</p>}
        {saved && <p className="muted small">Saved — the guest site picks this up straight away.</p>}

        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? "Saving…" : "Save café settings"}
        </button>
      </form>

      <p className="muted small">
        Guests reach this café at <strong>/c/{cafeSlug()}</strong> · staff sign in at{" "}
        <strong>/c/{cafeSlug()}/owner</strong>. Only this café's menu, orders and settings are visible
        behind that address.
      </p>
      <p className="muted small">
        Service style applies from the next order: table service needs a table QR, counter service gives every order a
        daily pickup number. Orders already placed keep the table or number they were taken with.
      </p>
      <p className="muted small">
        The name, phone, email and address appear across the guest site, including the policy pages payment providers
        review. Menu and tables live in their own tabs.
      </p>
    </section>
  );
}

function MenuTab({ call, csrfToken }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);
  const [form, setForm] = useState({
    name: "",
    category: "Coffee",
    description: "",
    price: "",
    emoji: "🍽️",
    available: true,
    diet: "",
  });
  const [saving, setSaving] = useState(false);
  // A ref is the synchronous guard: two submits in the same tick both see `saving === false` in the
  // closure, but only the first sees this latch closed.
  const savingRef = useRef(false);
  const [notice, setNotice] = useState("");
  const [editItem, setEditItem] = useState(null);
  // The editor is rendered below the whole menu, so opening it must bring it on screen; otherwise Edit on
  // a long menu looks like it did nothing. Focus goes to the first field for keyboard users.
  const editFormRef = useRef(null);
  const editingId = editItem ? editItem.id : null;
  useEffect(() => {
    if (editingId === null || !editFormRef.current) return;
    const form = editFormRef.current;
    if (typeof form.scrollIntoView === "function") form.scrollIntoView({ behavior: "smooth", block: "start" });
    const first = form.querySelector("input");
    if (first) first.focus({ preventScroll: true });
  }, [editingId]);
  const [pendingImage, setPendingImage] = useState({});
  const [imageBusy, setImageBusy] = useState(null);
  // The picker itself is hidden, so it is opened by a real button. That keeps the control in the tab
  // order and gives it an accessible name; the map holds one input per row without querying the DOM.
  const pickers = useRef(new Map());
  // One polite live region for the whole tab, so a screen reader hears the outcome of the row you
  // acted on instead of 27 competing status nodes.
  const [announcement, setAnnouncement] = useState("");
  const openPicker = (item) => {
    const input = pickers.current.get(item.id);
    if (input) input.click();
  };

  const onPickImage = (item, file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPendingImage((prev) => ({ ...prev, [item.id]: { file, url } }));
    setAnnouncement(`Photo ready to save for ${item.name}. Choose Save photo to keep it, or Cancel.`);
  };
  const cancelImage = (item) => {
    const pending = pendingImage[item.id];
    if (pending) URL.revokeObjectURL(pending.url);
    setPendingImage((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    setAnnouncement(`Preview cancelled for ${item.name}. The current photo is unchanged.`);
  };
  const saveImage = async (item) => {
    const pending = pendingImage[item.id];
    if (!pending) return;
    setImageBusy(item.id);
    setError("");
    try {
      const form = new FormData();
      form.append("file", pending.file);
      // The photo is a credential-adjacent mutation like sign-out-everywhere, so it carries the same
      // CSRF proof the settings save does.
      await call(`/api/admin/menu/${item.id}/image`, {
        method: "POST",
        body: form,
        headers: { "x-csrf-token": csrfToken },
      });
      URL.revokeObjectURL(pending.url);
      setPendingImage((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      await load();
      setAnnouncement(`Photo saved for ${item.name}.`);
    } catch (err) {
      setError(err.message);
      setAnnouncement(`We couldn't save the photo for ${item.name}. ${err.message}`);
    } finally {
      setImageBusy(null);
    }
  };
  const removeImage = async (item) => {
    if (!window.confirm("Remove this photo? Guests will see the plain placeholder until you upload another.")) return;
    setImageBusy(item.id);
    setError("");
    try {
      await call(`/api/admin/menu/${item.id}/image`, {
        method: "DELETE",
        headers: { "x-csrf-token": csrfToken },
      });
      await load();
      setAnnouncement(`Custom photo removed from ${item.name}. Guests see the placeholder again.`);
    } catch (err) {
      setError(err.message);
      setAnnouncement(`We couldn't remove the photo for ${item.name}. ${err.message}`);
    } finally {
      setImageBusy(null);
    }
  };

  const load = useCallback(async () => {
    try {
      const payload = await call("/api/admin/menu");
      setItems(payload.items);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [call]);

  useEffect(() => {
    load();
  }, [load]);

  const categories = useMemo(() => {
    const names = [];
    (items || []).forEach((item) => {
      if (!names.includes(item.category)) names.push(item.category);
    });
    return names;
  }, [items]);

  const toggle = async (item) => {
    setBusy(item.id);
    try {
      await call(`/api/admin/menu/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ available: !item.available }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (item) => {
    if (!window.confirm(`Remove ${item.name} from the menu? Past orders keep their record.`)) return;
    setBusy(item.id);
    try {
      await call(`/api/admin/menu/${item.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const priceCentsFor = (value) => Math.round(Number(value) * 100);

  const startEdit = (item) => {
    setEditItem(item);
    setForm({
      name: item.name,
      category: item.category,
      description: item.description,
      price: (item.priceCents / 100).toFixed(2),
      emoji: item.emoji,
      available: item.available,
      diet: item.diet || "",
    });
    setNotice("");
    setAnnouncement(`Editing ${item.name}.`);
  };

  const resetForm = (category = "Coffee") =>
    setForm({ name: "", category, description: "", price: "", emoji: "🍽️", available: true, diet: "" });

  const cancelEdit = () => {
    setEditItem(null);
    resetForm(form.category);
    setNotice("");
    setAnnouncement("Edit cancelled. The menu is unchanged.");
  };

  const saveEdit = async (event) => {
    event.preventDefault();
    // A double click or an Enter press while a save is in flight must not queue a second write.
    if (!editItem || savingRef.current) return;
    savingRef.current = true;

    const name = form.name.trim();
    if (!name) {
      savingRef.current = false;
      setError("Give the item a name.");
      return;
    }
    if (name.length > 60) {
      savingRef.current = false;
      setError("The item name is too long (60 characters max).");
      return;
    }
    const priceCents = priceCentsFor(form.price);
    if (!form.price.trim() || !Number.isSafeInteger(priceCents) || priceCents <= 0) {
      savingRef.current = false;
      setError("Enter a price greater than zero, for example 120.00.");
      return;
    }
    if (priceCents > 1_000_000) {
      savingRef.current = false;
      setError("That price is too large (up to 10,000.00).");
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");
    try {
      await call(`/api/admin/menu/${editItem.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          category: form.category.trim() || "Menu",
          description: form.description.trim(),
          emoji: form.emoji.trim() || "🍽️",
          priceCents,
          available: form.available,
          diet: form.diet || null,
        }),
      });
      setEditItem(null);
      resetForm(form.category);
      await load();
      setNotice(`Saved ${name}. The customer menu and new orders now show the update.`);
      setAnnouncement(`Saved ${name}.`);
    } catch (err) {
      setError(err.message);
      setAnnouncement(`We couldn't save ${editItem.name}: ${err.message}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const addItem = async (event) => {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await call("/api/admin/menu", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          category: form.category,
          description: form.description,
          emoji: form.emoji,
          priceCents: priceCentsFor(form.price),
          diet: form.diet || null,
        }),
      });
      resetForm(form.category);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="board-head-row">
        <h1>Menu</h1>
        <p className="muted small">Toggle items off when they sell out</p>
      </div>

      {/* Announced, not just shown: a failed photo save used to be silent to a screen reader. */}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="muted small">{notice}</p>}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {!items && <p className="muted">Loading menu…</p>}

      {items &&
        categories.map((category) => (
          <div key={category} className="menu-admin-group">
            <h2>{category}</h2>
            <ul className="admin-items">
              {items
                .filter((item) => item.category === category)
                .map((item) => (
                  <li key={item.id} className={`admin-item${item.available ? "" : " off"}`}>
                    <span className="menu-emoji small-emoji" aria-hidden="true">
                      {pendingImage[item.id] ? (
                        <img src={pendingImage[item.id].url} alt="" />
                      ) : item.hasCustomImage && item.imageUrl ? (
                        <img src={item.imageUrl} alt="" />
                      ) : (
                        placeholderInitial(item)
                      )}
                    </span>
                    <div className="admin-item-text">
                      <strong>
                        <DietMark diet={item.diet} />
                        {item.name}
                      </strong>
                      <p className="muted small">
                        {money(item.priceCents)} · {pendingImage[item.id] ? "Preview (not saved)" : item.hasCustomImage ? "Custom photo" : "No photo yet"}
                      </p>
                    </div>
                    {/* One group, so a narrow screen can move every row control onto its own line
                        instead of squeezing the item name into a sliver. */}
                    <div className="admin-item-actions">
                      <div className="admin-item-photo">
                        {pendingImage[item.id] ? (
                          <>
                            <button
                              type="button"
                              className="btn primary small-btn"
                              onClick={() => saveImage(item)}
                              disabled={imageBusy === item.id}
                            >
                              {imageBusy === item.id ? "Saving…" : "Save photo"}
                            </button>
                            <button
                              type="button"
                              className="btn ghost small-btn"
                              onClick={() => cancelImage(item)}
                              disabled={imageBusy === item.id}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn ghost small-btn"
                              onClick={() => openPicker(item)}
                              disabled={imageBusy === item.id || editItem !== null}
                              aria-label={`${item.hasCustomImage ? "Replace" : "Upload"} photo for ${item.name}`}
                            >
                              {imageBusy === item.id ? "Uploading…" : "Upload / Replace"}
                            </button>
                            {/* Opened by the button above. Hidden from the tab order and the
                                accessibility tree so the same action is not offered twice. */}
                            <input
                              ref={(node) => {
                                if (node) pickers.current.set(item.id, node);
                                else pickers.current.delete(item.id);
                              }}
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              hidden
                              tabIndex={-1}
                              aria-hidden="true"
                              disabled={imageBusy === item.id || editItem !== null}
                              onChange={(e) => {
                                const file = e.target.files && e.target.files[0];
                                if (file) onPickImage(item, file);
                                e.target.value = "";
                              }}
                            />
                            {item.hasCustomImage && (
                              <button
                                type="button"
                                className="btn ghost small-btn"
                                onClick={() => removeImage(item)}
                                disabled={imageBusy === item.id}
                                aria-label={`Remove photo from ${item.name}`}
                              >
                                Remove photo
                              </button>
                            )}
                          </>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn ghost small-btn"
                        onClick={() => startEdit(item)}
                        disabled={busy === item.id || editItem !== null}
                        aria-label={`Edit ${item.name}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={`switch${item.available ? " on" : ""}`}
                        onClick={() => toggle(item)}
                        disabled={busy === item.id || editItem !== null}
                        aria-pressed={item.available}
                        // A toggle's name says what it controls and aria-pressed says its state, so a
                        // screen reader hears "Masala Chai available, pressed" rather than an unnamed
                        // "Sold out" that could belong to any of the rows.
                        aria-label={`${item.name} available`}
                      >
                        <span />
                        <em>{item.available ? "Available" : "Sold out"}</em>
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger"
                        onClick={() => remove(item)}
                        disabled={busy === item.id || editItem !== null}
                        aria-label={`Delete ${item.name}`}
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                ))}
            </ul>
          </div>
        ))}

      {editItem ? (
        <form className="add-form" onSubmit={saveEdit} ref={editFormRef}>
          <h2>Edit item</h2>
          <p className="muted small">
            Save to update the customer menu and the price new orders pay. Orders already placed keep
            the name and price they were taken with. Cancel leaves the item unchanged.
          </p>
          <div className="add-grid">
            <label className="field">
              <span>Name</span>
              <input
                required
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Banana bread"
              />
            </label>
            <label className="field">
              <span>Category</span>
              <input
                value={form.category}
                onChange={(event) => setForm({ ...form, category: event.target.value })}
                list="category-options"
                placeholder="Something Sweet"
              />
              <datalist id="category-options">
                {categories.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>Price</span>
              <input
                required
                type="number"
                min="0.5"
                step="0.10"
                value={form.price}
                onChange={(event) => setForm({ ...form, price: event.target.value })}
                placeholder="120.00"
              />
            </label>
          <label className="field">
            <span>Food type</span>
            <select value={form.diet} onChange={(event) => setForm({ ...form, diet: event.target.value })}>
              <option value="">Not stated</option>
              <option value="veg">Veg (green mark)</option>
              <option value="nonveg">Non-veg (red mark)</option>
              <option value="egg">Egg (brown mark)</option>
            </select>
          </label>
          <label className="field">
            <span>Icon</span>
            <input
              value={form.emoji}
              onChange={(event) => setForm({ ...form, emoji: event.target.value })}
              maxLength={8}
            />
          </label>
        </div>
        <label className="field">
          <span>Description</span>
          <input
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            placeholder="Toasted, with whipped butter"
          />
        </label>
        <label className="field">
          <span>Availability</span>
          <span className="muted small">
            <input
              type="checkbox"
              checked={form.available}
              onChange={(event) => setForm({ ...form, available: event.target.checked })}
            />{" "}
            {form.available ? "Available on the menu" : "Sold out"}
          </span>
        </label>
        <div className="add-grid">
          <button type="submit" className="btn primary" disabled={saving || editItem === null}>
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button type="button" className="btn ghost" onClick={cancelEdit} disabled={saving}>
            Cancel
          </button>
        </div>
      </form>
      ) : (
        <form className="add-form" onSubmit={addItem}>
          <h2>Add an item</h2>
          <div className="add-grid">
            <label className="field">
              <span>Name</span>
              <input
                required
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Banana bread"
              />
            </label>
            <label className="field">
              <span>Category</span>
              <input
                value={form.category}
                onChange={(event) => setForm({ ...form, category: event.target.value })}
                list="category-options"
                placeholder="Something Sweet"
              />
              <datalist id="category-options">
                {categories.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>Price</span>
              <input
                required
                type="number"
                min="0.5"
                step="0.10"
                value={form.price}
                onChange={(event) => setForm({ ...form, price: event.target.value })}
                placeholder="120.00"
              />
            </label>
            <label className="field">
              <span>Food type</span>
              <select value={form.diet} onChange={(event) => setForm({ ...form, diet: event.target.value })}>
                <option value="">Not stated</option>
                <option value="veg">Veg (green mark)</option>
                <option value="nonveg">Non-veg (red mark)</option>
                <option value="egg">Egg (brown mark)</option>
              </select>
            </label>
            <label className="field">
              <span>Icon</span>
              <input
                value={form.emoji}
                onChange={(event) => setForm({ ...form, emoji: event.target.value })}
                maxLength={8}
              />
            </label>
          </div>
          <label className="field">
            <span>Description</span>
            <input
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Toasted, with whipped butter"
            />
          </label>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? "Adding…" : "Add to menu"}
          </button>
        </form>
      )}
    </section>
  );
}

// A counter (pickup) café has no tables, so it gets one code for /c/<slug>/menu instead of one per table.
// Scanning a table code in a pickup café used to end at "Send order" with "This café takes pickup
// orders — no table is needed."; the menu now treats such a visit as a pickup order, and this is the
// code to print instead. It has its own tab, in the place of Tables & QR; the printed sheet carries only
// the café name, "Scan to order" and the code.
function CounterQrCard({ cafe }) {
  const path = cafePath("/menu");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");

  useEffect(() => {
    setUrl(`${window.location.origin}${path}`);
  }, [path]);

  useEffect(() => {
    if (!url) return undefined;
    let alive = true;
    QRCode.toDataURL(url, { margin: 1, width: 640, color: { dark: "#231713", light: "#ffffff" } })
      .then((value) => {
        if (alive) setCode(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);

  // While printing, the body class tells the print styles to show the card alone (no heading, buttons or
  // notes). It is removed when the print dialog closes.
  const printSheet = () => {
    const body = window.document.body;
    const done = () => {
      body.classList.remove("printing-counter-qr");
      window.removeEventListener("afterprint", done);
    };
    body.classList.add("printing-counter-qr");
    window.addEventListener("afterprint", done);
    window.print();
  };

  return (
    <section className="counter-qr">
      <div className="board-head-row no-print">
        <h1>Counter QR code</h1>
        <p className="muted small">One code for the whole café — guests scan it to order for pickup</p>
      </div>

      <div className="table-tools counter-qr-tools no-print">
        <button type="button" className="btn ghost small-btn" onClick={printSheet}>
          Print sheet
        </button>
        <a
          className="btn primary small-btn"
          href={code || "#"}
          download={`qr-counter-${cafeSlug() || "cafe"}.png`}
          aria-disabled={code ? undefined : "true"}
        >
          Download PNG
        </a>
      </div>

      <article className="qr-card counter-qr-card" data-qr-url={url || undefined}>
        <h2>{cafe}</h2>
        <p className="counter-qr-cta">Scan to order</p>
        {code ? (
          <img src={code} alt={`QR code to order from ${cafe}`} className="qr-img" />
        ) : (
          <div className="qr-img skeleton" />
        )}
        <a className="url-note no-print" href={path} target="_blank" rel="noreferrer">
          /c/{cafeSlug()}/menu
        </a>
      </article>

      <p className="muted small no-print counter-qr-note">
        Table QR codes are only used for table service. Switch the service style to table service in Café setup and
        the Tables &amp; QR tab comes back with your existing tables.
      </p>
    </section>
  );
}

function TablesTab({ call }) {
  const [tables, setTables] = useState(null);
  const [codes, setCodes] = useState({});
  const [error, setError] = useState("");
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const load = useCallback(async () => {
    try {
      const payload = await call("/api/admin/tables");
      setTables(payload.tables);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [call]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!tables || !origin) return;
    let alive = true;
    (async () => {
      const entries = await Promise.all(
        tables.map(async (table) => {
          const url = await QRCode.toDataURL(`${origin}${cafePath(`/t/${table.id}`)}`, {
            margin: 1,
            width: 400,
            color: { dark: "#231713", light: "#ffffff" },
          });
          return [table.id, url];
        })
      );
      if (alive) setCodes(Object.fromEntries(entries));
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [tables, origin]);

  const addTable = async () => {
    try {
      await call("/api/admin/tables", { method: "POST", body: JSON.stringify({}) });
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section>
      <div className="board-head-row">
        <h1>Tables &amp; QR codes</h1>
        <p className="muted small">Print one code per table — it opens the menu for that table</p>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}
      <div className="table-tools no-print">
        <button type="button" className="btn ghost small-btn" onClick={() => window.print()}>
          Print sheet
        </button>
        <button type="button" className="btn primary small-btn" onClick={addTable}>
          Add a table
        </button>
      </div>

      {!tables && <p className="muted">Loading tables…</p>}

      <div className="qr-grid">
        {(tables || []).map((table) => (
          <article key={table.id} className="qr-card">
            <h2>{table.label}</h2>
            {codes[table.id] ? (
              <img src={codes[table.id]} alt={`QR code for ${table.label}`} className="qr-img" />
            ) : (
              <div className="qr-img skeleton" />
            )}
            <p className="muted small">{table.seats} seats</p>
            <a
              className="btn ghost small-btn no-print"
              href={codes[table.id] || "#"}
              download={`qr-${table.label.toLowerCase().replace(/\s+/g, "-")}.png`}
            >
              Download PNG
            </a>
            <a
              className="url-note no-print"
              href={cafePath(`/t/${table.id}`)}
              target="_blank"
              rel="noreferrer"
            >
              /c/{cafeSlug()}/t/{table.id}
            </a>
          </article>
        ))}
      </div>
    </section>
  );
}
// Second factor and session inventory. Both are credential surfaces, so every mutation here proves the
// current password (or the factor itself) and the server bumps the credential version: sessions that
// existed before the change are dead afterwards, which is the point.
function SecurityTab({ call, onSignOut }) {
  const [state, setState] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [regenPassword, setRegenPassword] = useState("");
  const [regenCode, setRegenCode] = useState("");
  const [copied, setCopied] = useState(false);

  // The plaintext set is never stored, so a refresh loses it for good. Warn before a tab close or
  // reload while the codes are still on screen, instead of letting the owner lose them silently.
  useEffect(() => {
    if (recoveryCodes.length === 0) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recoveryCodes.length]);

  const load = useCallback(async () => {
    const [mfa, list] = await Promise.all([call("/api/admin/mfa"), call("/api/admin/sessions")]);
    setState(mfa);
    setSessions((list && list.sessions) || []);
  }, [call]);

  useEffect(() => {
    let alive = true;
    load().catch((err) => {
      if (alive) setError(err.message);
    });
    return () => {
      alive = false;
    };
  }, [load]);

  const run = async (work) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const enroll = () =>
    run(async () => {
      const payload = await call("/api/admin/mfa/enroll", {
        method: "POST",
        body: JSON.stringify({ currentPassword: password }),
      });
      setEnrollment(payload);
      setNotice("Add the secret to your authenticator app, then enter a generated code to switch it on.");
    });

  const confirm = () =>
    run(async () => {
      const payload = await call("/api/admin/mfa/confirm", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      setRecoveryCodes((payload && payload.recoveryCodes) || []);
      setEnrollment(null);
      setPassword("");
      setCode("");
      setNotice("Two-factor sign-in is on. Store the recovery codes, then sign in again.");
      await load();
    });

  const disable = () =>
    run(async () => {
      await call("/api/admin/mfa/disable", {
        method: "POST",
        body: JSON.stringify({ currentPassword: password, code }),
      });
      setPassword("");
      setCode("");
      setNotice("Two-factor sign-in is off. Sign in again with your password.");
      await load();
    });

  const regenerate = () =>
    run(async () => {
      const payload = await call("/api/admin/mfa/recovery-regenerate", {
        method: "POST",
        body: JSON.stringify({ currentPassword: regenPassword, code: regenCode }),
      });
      setRecoveryCodes((payload && payload.recoveryCodes) || []);
      setRegenPassword("");
      setRegenCode("");
      setConfirmRegenerate(false);
      setCopied(false);
      setNotice(
        "New recovery codes issued. Every previous code has stopped working, and these are shown only now."
      );
      await load();
    });

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setCopied(true);
    } catch {
      setError("Couldn't copy automatically. Select the codes and copy them by hand.");
    }
  };

  const cancelRegenerate = () => {
    setConfirmRegenerate(false);
    setRegenPassword("");
    setRegenCode("");
  };

  const revoke = (id) =>
    run(async () => {
      await call(`/api/admin/sessions/${id}/revoke`, { method: "POST" });
      await load();
    });

  if (!state) return <p className="muted">{error || "Loading security settings…"}</p>;

  return (
    <section>
      <div className="board-head-row">
        <h1>Security</h1>
        <p className="muted small">Two-factor sign-in and the devices signed into this café</p>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="muted small">{notice}</p>}

      {state.managed ? (
        <p className="muted small">
          This café signs in with a managed identity, so its second factor is enforced by the provider,
          not here.
        </p>
      ) : !state.available ? (
        <p className="muted small">
                    Two-factor sign-in isn't configured on this deployment yet. It needs a dedicated MFA_ENC_KEY
          (32 random bytes, base64url) set as a Worker secret.
        </p>
      ) : state.enabled ? (
        <div className="add-form">
          <h2 className="small">Two-factor is on</h2>
          <p className="muted small">
            {state.recoveryCodesRemaining} recovery code
            {state.recoveryCodesRemaining === 1 ? "" : "s"} left. Turning it off needs your password and
            a current code.
          </p>
          <label className="field">
            <span>Current owner password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Authenticator or recovery code</span>
            <input
              type="text"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456 or ABCD-EFGH"
            />
          </label>
          <button type="button" className="btn ghost" onClick={disable} disabled={busy || !password || !code}>
            {busy ? "Working…" : "Turn off two-factor"}
          </button>
        </div>
      ) : enrollment ? (
        <div className="add-form">
          <h2 className="small">Confirm the authenticator</h2>
          <p className="muted small">
            Type this secret into your authenticator app (or open the link below), then enter the
            6-digit code it shows.
          </p>
          <p className="url-note" style={{ wordBreak: "break-all" }}>
            {enrollment.secret}
          </p>
          <p className="muted small">
            <a href={enrollment.otpauth} rel="noreferrer">
              Open in your authenticator app
            </a>
          </p>
          <label className="field">
            <span>Code from the app</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456"
            />
          </label>
          <button type="button" className="btn primary" onClick={confirm} disabled={busy || code.length < 6}>
            {busy ? "Checking…" : "Turn on two-factor"}
          </button>
        </div>
      ) : (
        <div className="add-form">
          <h2 className="small">Two-factor is off</h2>
          <p className="muted small">
            A password alone opens this café's board. Turning this on adds a 6-digit code from an
            authenticator app and signs out every other device.
          </p>
          <label className="field">
            <span>Current owner password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button type="button" className="btn primary" onClick={enroll} disabled={busy || !password}>
            {busy ? "Starting…" : "Set up two-factor"}
          </button>
        </div>
      )}

      {state.enabled && (
        <div className="add-form">
          <h2 className="small">Recovery codes</h2>
          <p className="muted small">
            {state.recoveryCodesRemaining} recovery code
            {state.recoveryCodesRemaining === 1 ? "" : "s"} left. Each works once instead of your
            authenticator. Replacing the set invalidates every previous code, so any copy you have
            saved stops working immediately.
          </p>
          {!confirmRegenerate ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => setConfirmRegenerate(true)}
              disabled={busy}
            >
              Replace recovery codes
            </button>
          ) : (
            <>
              <p className="muted small">
                This can't be undone. Enter your current password and the code from your authenticator
                to confirm.
              </p>
              <label className="field">
                <span>Current owner password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={regenPassword}
                  onChange={(event) => setRegenPassword(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Code from the app</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={regenCode}
                  onChange={(event) => setRegenCode(event.target.value)}
                  placeholder="123456"
                />
              </label>
              <p className="table-tools">
                <button
                  type="button"
                  className="btn primary"
                  onClick={regenerate}
                  disabled={busy || !regenPassword || regenCode.length < 6}
                >
                  {busy ? "Replacing…" : "Confirm and replace"}
                </button>{" "}
                <button type="button" className="btn ghost" onClick={cancelRegenerate} disabled={busy}>
                  Cancel
                </button>
              </p>
            </>
          )}
        </div>
      )}

      {recoveryCodes.length > 0 && (
        <div className="add-form">
          <h2 className="small">Recovery codes</h2>
          <p className="muted small">
            Each code works once, in place of an authenticator code. This is the only time they are
            shown: save them somewhere safe before leaving or refreshing this screen. They are not
            stored anywhere they can be shown again.
          </p>
          <ul className="url-note">
            {recoveryCodes.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
          <button type="button" className="btn ghost small-btn" onClick={copyCodes}>
            {copied ? "Copied" : "Copy codes"}
          </button>
        </div>
      )}

      <h2 className="small">Signed-in devices</h2>
      {sessions.length === 0 ? (
        <p className="muted small">No live sessions.</p>
      ) : (
        <ul className="url-note">
          {sessions.map((session) => (
            <li key={session.id}>
              {session.id} · started {new Date(session.created).toLocaleString()} · expires{" "}
              {new Date(session.expires).toLocaleTimeString()}
              {session.current ? (
                <> · this device</>
              ) : (
                <>
                  {" "}
                  <button
                    type="button"
                    className="btn ghost small-btn"
                    onClick={() => revoke(session.id)}
                    disabled={busy}
                  >
                    End
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        <button type="button" className="btn ghost small-btn" onClick={onSignOut}>
          Sign out of this device
        </button>
      </p>
    </section>
  );
}
