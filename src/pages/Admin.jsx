import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import QRCode from "qrcode";
import { api, cafePath, cafeSlug } from "../lib/api.js";
import { cafeName, refreshSiteConfig, useSiteConfig } from "../lib/config.js";
import { clockTime, money, timeAgo } from "../lib/money.js";

const WARM_MINUTES = 10;
const LATE_MINUTES = 20;

export default function Admin() {
  const [session, setSession] = useState("checking");
  // Bumped after a settings save so the header picks up a renamed café without a page reload.
  const [revision, setRevision] = useState(0);
  const config = useSiteConfig(revision);
  const cafe = cafeName(config);

  // The session is an HttpOnly cookie, so the page cannot see it — it has to ask the server once
  // on load instead of reading a token out of storage.
  useEffect(() => {
    let alive = true;
    localStorage.removeItem("admin_token");
    api("/api/admin/session")
      .then(() => {
        if (alive) setSession("in");
      })
      .catch(() => {
        if (alive) setSession("out");
      });
    return () => {
      alive = false;
    };
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api("/api/admin/logout", { method: "POST" });
    } catch {
      /* clearing the screen matters more than the request succeeding */
    }
    setSession("out");
  }, []);

  if (session === "checking") {
    return (
      <main className="login-wrap">
        <p className="muted small">Checking your session…</p>
      </main>
    );
  }

  if (session === "out") return <AdminLogin onSignIn={() => setSession("in")} />;
  return (
    <AdminShell
      onSignOut={signOut}
      cafe={cafe}
      payments={config && config.payments}
      onSettingsSaved={async () => {
        await refreshSiteConfig();
        setRevision((value) => value + 1);
      }}
    />
  );
}

function AdminLogin({ onSignIn }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: pin }) });
      onSignIn();
    } catch (err) {
      setError(err.message);
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
        <p className="muted small">Enter the owner password to open the order board.</p>
        <label className="field">
          <span>Password</span>
          <input
            className="pin-input"
            type="password"
            autoComplete="current-password"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            placeholder="••••"
            autoFocus
          />
        </label>
        {error && <p className="alert">{error}</p>}
        <button type="submit" className="btn primary" disabled={busy || pin.length === 0}>
          {busy ? "Checking…" : "Open the board"}
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
  if (!payments) return "payments loading";
  return payments.gateway ? "Razorpay checkout on" : "Razorpay keys missing — counter payments only";
}

function AdminShell({ onSignOut, cafe, payments, onSettingsSaved }) {
  const [tab, setTab] = useState("orders");

  const call = useCallback(
    async (path, options = {}) => {
      try {
        return await api(path, options);
      } catch (err) {
        if (err.status === 401) onSignOut();
        throw err;
      }
    },
    [onSignOut]
  );

  return (
    <div className="admin">
      <header className="admin-top">
        <div className="admin-brand">
          <span className="brand-mark small" aria-hidden="true">
            ☕
          </span>
          <div>
            <strong>{cafe}</strong>
            <p className="muted small">Staff screen · {paymentMode(payments)}</p>
          </div>
        </div>
        <div className="admin-top-actions">
          <Link className="btn ghost small-btn" to={cafePath("")}>
            View menu
          </Link>
          <button type="button" className="btn ghost small-btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="admin-tabs" aria-label="Staff sections">
        {[
          ["orders", "Orders"],
          ["menu", "Menu"],
          ["tables", "Tables & QR"],
          ["settings", "Café setup"],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`admin-tab${tab === key ? " active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="admin-body">
        {tab === "orders" && <OrdersTab call={call} cafe={cafe} />}
        {tab === "menu" && <MenuTab call={call} />}
        {tab === "tables" && <TablesTab call={call} />}
        {tab === "settings" && <SettingsTab call={call} onSaved={onSettingsSaved} />}
      </div>
    </div>
  );
}

function OrdersTab({ call, cafe }) {
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
            (order.paymentStatus === "confirmed" || order.paymentStatus === "counter")
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

  useEffect(() => {
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
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
    document.title = openNow ? `(${openNow}) Orders · ${cafe}` : `Staff · ${cafe}`;
    return () => {
      document.title = cafe;
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
    { key: "ready", title: "Ready", action: "Done", next: "served" },
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
  const visible = (view === "paid" ? orders.filter(settled) : orders.filter((order) => !settled(order))).filter(matches);
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
        <h1>{view === "paid" ? "Paid orders" : "Unpaid / failed"}</h1>
        {arrived.length > 0 && (
          <button type="button" className="new-pill" onClick={() => setArrived([])}>
            {arrived.length} new {arrived.length === 1 ? "order" : "orders"} · tap to clear
          </button>
        )}
        <p className="muted small">Live · refreshes every 4s · {open.length} open</p>
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
            <span>Counter cash</span>
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
            <em>{stats.orders} orders today</em>
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

      {error && <p className="alert">{error}</p>}

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
                          <span>{item.name}</span>
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
                          Cash received
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
    counter: ["Pay at counter", "counter"],
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
        if (alive) setForm({ ...payload.settings, password: "" });
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
          ...(form.password ? { password: form.password } : {}),
        }),
      });
      setForm({ ...payload.settings, password: "" });
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

        {error && <p className="alert">{error}</p>}
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

function MenuTab({ call }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);
  const [form, setForm] = useState({ name: "", category: "Coffee", description: "", price: "", emoji: "🍽️" });
  const [saving, setSaving] = useState(false);

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

  const addItem = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await call("/api/admin/menu", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          category: form.category,
          description: form.description,
          emoji: form.emoji,
          priceCents: Math.round(Number(form.price) * 100),
        }),
      });
      setForm({ name: "", category: form.category, description: "", price: "", emoji: "🍽️" });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="board-head-row">
        <h1>Menu</h1>
        <p className="muted small">Toggle items off when they sell out</p>
      </div>

      {error && <p className="alert">{error}</p>}
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
                      {item.emoji}
                    </span>
                    <div className="admin-item-text">
                      <strong>{item.name}</strong>
                      <p className="muted small">{money(item.priceCents)}</p>
                    </div>
                    <button
                      type="button"
                      className={`switch${item.available ? " on" : ""}`}
                      onClick={() => toggle(item)}
                      disabled={busy === item.id}
                      aria-pressed={item.available}
                    >
                      <span />
                      <em>{item.available ? "Available" : "Sold out"}</em>
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      onClick={() => remove(item)}
                      disabled={busy === item.id}
                      aria-label={`Delete ${item.name}`}
                    >
                      ✕
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        ))}

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
              placeholder="6.50"
            />
          </label>
          <label className="field">
            <span>Icon</span>
            <input
              value={form.emoji}
              onChange={(event) => setForm({ ...form, emoji: event.target.value })}
              maxLength={4}
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

      {error && <p className="alert">{error}</p>}
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
