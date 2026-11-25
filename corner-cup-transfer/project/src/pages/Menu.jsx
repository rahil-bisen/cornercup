import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, cafePath, cafeSlug } from "../lib/api.js";
import { cafeName, useSiteConfigState } from "../lib/config.js";
import { isCurrentScope, menuScope } from "../lib/menuScope.js";
import { money } from "../lib/money.js";
import CartSheet from "../components/CartSheet.jsx";
import {
  abandonPendingCheckout,
  checkoutAction,
  checkoutStorageKey,
  clearCheckout,
  openCheckout,
  readCheckout,
} from "../lib/checkout.js";

export default function Menu() {
  const { tableId: routeTable } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const queryTable = search.get("table");
  const linkTable = routeTable || queryTable;
  const cafeKey = cafeSlug() || "cafe";
  // Tables are remembered per café: two outlets sharing a browser must never borrow each other's table.
  const tableStorageKey = `cafe_table:${cafeKey}`;
  // The QR code carries the table in the path; ?table=N is accepted too. Either way it is kept for
  // the session, so a refresh or a detour to a policy page doesn't lose the table before checkout.
  // Only the URL is trusted up front — a remembered table is restored after the service mode is known.
  const [tableId, setTableId] = useState(() => (linkTable ? String(linkTable) : ""));
  // A menu or table list is tagged with what it was fetched for, so one café's answer can never be
  // rendered under another café's header — not even in the frame before the new request lands.
  const [menuState, setMenuState] = useState({ scope: null, data: null });
  const [tablesState, setTablesState] = useState({ scope: null, rows: [] });
  const [error, setError] = useState("");
  // Each failed resource gets its own message and its own retry counter, so a retry re-runs exactly one
  // request. Neither counter is ever bumped on a timer: only the guest's click moves them.
  const [tablesError, setTablesError] = useState("");
  const [tablesAttempt, setTablesAttempt] = useState(0);
  const [menuAttempt, setMenuAttempt] = useState(0);
  // The basket key follows the table, or "takeaway" for a counter-service café, so the two flows
  // can share a browser without mixing their carts.
  const cartKey = `cart:${cafeKey}:${tableId ? `table-${tableId}` : "takeaway"}`;
  // Every key keeps its own basket, and writes go back to the key they were read from, so a table or
  // café change can neither copy one basket into another nor clear the one left behind.
  const [carts, setCarts] = useState(() => ({ [cartKey]: readCart(cartKey) }));
  const cart = carts[cartKey] !== undefined ? carts[cartKey] : readCart(cartKey);
  const setCart = (update) =>
    setCarts((current) => {
      const base = current[cartKey] !== undefined ? current[cartKey] : readCart(cartKey);
      return { ...current, [cartKey]: typeof update === "function" ? update(base) : update };
    });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [note, setNote] = useState("");
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState("");
  const [resolvedOrder, setResolvedOrder] = useState(null);

  // The tracking token rides in the URL fragment: it is never sent to the server in a request line,
  // never reaches an access log, and browsers strip it from any Referer.
  function orderLink(order, token, table) {
    const path = cafePath(table ? `/t/${table}/order/${order.id}` : `/order/${order.id}`);
    return token ? `${path}#t=${encodeURIComponent(token)}` : path;
  }
  const { config, error: configError, retry: retryConfig } = useSiteConfigState();
  const cafe = cafeName(config);
  // Set by the café (SERVICE_MODE=counter): no table to scan, the guest gets a pickup number instead.
  const counterService = Boolean(config && config.service && config.service.mode === "counter");
  // In-app navigation to another café must not carry the previous café's table along. This is adjusted
  // during render rather than in an effect on purpose: an effect runs after the commit, which leaves one
  // render in which the new café is asked for the previous café's table — and the server answers an
  // unknown table with a 404, so the guest would see "we couldn't find that table" flash before the real
  // menu arrived. React re-runs the render before committing, so no request is ever made for that pass.
  const [tableCafe, setTableCafe] = useState(cafeKey);
  if (tableCafe !== cafeKey) {
    setTableCafe(cafeKey);
    setTableId(linkTable ? String(linkTable) : "");
    setTablesError("");
    setError("");
  }

  // Everything a menu request depends on, as one value. It is the effect's dependency, so changing
  // café refetches even when the table number and the service mode stay identical.
  const menuScopeKey = menuScope({ cafeKey, tableId, counterService });
  const data = isCurrentScope(menuState.scope, menuScopeKey) ? menuState.data : null;
  const tables = isCurrentScope(tablesState.scope, cafeKey) ? tablesState.rows : [];

  // A table in the URL is the guest's explicit choice, so it beats anything remembered, and it is
  // remembered for this café only. A counter café has no tables, so it stores nothing.
  useEffect(() => {
    if (!linkTable) return;
    setTableId(String(linkTable));
    if (!counterService) sessionStorage.setItem(tableStorageKey, String(linkTable));
  }, [linkTable, counterService, tableStorageKey]);

  // The remembered table is restored only once the café's service mode is known: restoring it before
  // that is how a table from one café could hijack another café's menu.
  useEffect(() => {
    if (!config) return;
    if (counterService) {
      sessionStorage.removeItem(tableStorageKey);
      setTableId(linkTable ? String(linkTable) : "");
      return;
    }
    if (linkTable) return;
    const stored = sessionStorage.getItem(tableStorageKey);
    if (stored) setTableId((current) => current || stored);
  }, [config, counterService, linkTable, tableStorageKey]);

  // Keys written by older builds are unscoped, so there is no telling which café they belong to.
  // They are dropped instead of trusted, or one café's table would follow a guest into the next.
  useEffect(() => {
    sessionStorage.removeItem("cafe_table");
  }, []);

  // Only needed when the guest arrived without a table, so the picker has something to show. It waits
  // for the café's settings to settle first: until the service mode is known, a counter café would be
  // asked for a table list it does not have, and that answer could only ever be thrown away. Waiting
  // costs nothing visible, because the picker itself cannot be rendered before the mode is known.
  useEffect(() => {
    if (!config && !configError) return undefined;
    if (tableId || counterService) return undefined;
    let alive = true;
    setTablesError("");
    api("/api/tables")
      .then((payload) => {
        if (alive) setTablesState({ scope: cafeKey, rows: payload.tables || [] });
      })
      .catch((err) => {
        // A list that never arrives must not keep posing as "still loading", and a request we dropped
        // ourselves is not a failure worth showing.
        if (alive && !(err && err.canceled)) setTablesError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [tableId, counterService, cafeKey, tablesAttempt, config, configError]);

  const pickTable = (id) => {
    if (!counterService) sessionStorage.setItem(tableStorageKey, String(id));
    setTableId(String(id));
    navigate(cafePath(`/t/${id}`));
  };

  useEffect(() => {
    if (!tableId && !counterService) return undefined;
    let alive = true;
    setError("");
    api(tableId ? `/api/menu?table=${encodeURIComponent(tableId)}` : "/api/menu")
      .then((payload) => {
        if (alive) setMenuState({ scope: menuScopeKey, data: payload });
      })
      .catch((err) => {
        if (alive && !(err && err.canceled)) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [menuScopeKey, menuAttempt]);

  useEffect(() => {
    if (carts[cartKey] === undefined) return;
    localStorage.setItem(cartKey, JSON.stringify(carts[cartKey]));
  }, [carts, cartKey]);

  useEffect(() => {
    document.body.classList.toggle("sheet-open", sheetOpen);
    return () => document.body.classList.remove("sheet-open");
  }, [sheetOpen]);

  const itemsById = useMemo(() => {
    const map = new Map();
    (data ? data.categories : []).forEach((category) => {
      category.items.forEach((item) => map.set(item.id, { ...item, category: category.name }));
    });
    return map;
  }, [data]);

  const lines = useMemo(
    () =>
      Object.entries(cart)
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => ({ item: itemsById.get(Number(id)), qty }))
        .filter((line) => line.item && line.item.available),
    [cart, itemsById]
  );

  const itemCount = lines.reduce((sum, line) => sum + line.qty, 0);
  const total = lines.reduce((sum, line) => sum + line.item.priceCents * line.qty, 0);

  const setQty = (itemId, qty) => {
    setCart((current) => {
      const next = { ...current };
      if (qty <= 0) delete next[itemId];
      else next[itemId] = Math.min(20, qty);
      return next;
    });
  };

  // Scoped like the cart, so two tables sharing one browser never share a checkout key.
  const checkoutKey = checkoutStorageKey(cafeSlug(), tableId);

  const buildCheckoutPayload = () => ({
    ...(tableId ? { tableId: Number(tableId) } : {}),
    note,
    paymentMethod: "razorpay",
    items: lines.map((line) => ({ itemId: line.item.id, qty: line.qty })).sort((a, b) => a.itemId - b.itemId),
  });

  // A reload rebuilds the pending body from the stored note, so an untouched cart is the same checkout.
  useEffect(() => {
    const pending = readCheckout(checkoutKey);
    if (!pending) return;
    try {
      const parsed = JSON.parse(pending.body);
      if (typeof parsed.note === "string") setNote(parsed.note);
    } catch {
      /* a corrupt entry is replaced only after a conclusive reply */
    }
  }, [checkoutKey]);

  const placeOrder = async () => {
    setPlaceError("");
    if (!tableId && !counterService) {
      setPlaceError("Pick your table first — the kitchen needs to know where to bring it.");
      return;
    }
    setPlacing(true);

    const body = JSON.stringify(buildCheckoutPayload());
    const pending = readCheckout(checkoutKey);

    try {
      // The cart changed while a checkout was unresolved. Never re-POST the old body: if that request
      // never reached the server, the POST would place an order the guest no longer wants. Settle the
      // old key first, and trust only a terminal answer.
      if (checkoutAction(pending, body) === "verify") {
        const settled = await abandonPendingCheckout(checkoutKey, api);

        if (settled.state === "committed") {
          setResolvedOrder(
            settled.order ? { ...settled.order, trackToken: settled.trackToken || null } : null
          );
          return;
        }
        if (settled.state === "unverified") {
          setPlaceError("We couldn't verify your earlier checkout. Please start again, or ask our staff to look it up.");
          return;
        }
        if (settled.state !== "abandoned") {
          setPlaceError("We couldn't confirm your previous order yet. Please try again in a moment.");
          return;
        }
      }

      const attempt = openCheckout(checkoutKey, body);
      const payload = await api("/api/orders", {
        method: "POST",
        headers: { "Idempotency-Key": attempt.key },
        body: attempt.body,
      });

      clearCheckout(checkoutKey);
      localStorage.removeItem(cartKey);
      setCart({});
      setNote("");
      setSheetOpen(false);
      navigate(orderLink(payload.order, payload.trackToken, tableId));
    } catch (err) {
      // A key the server has tied to another payload can never be ours again.
      if (err && (err.code === "idempotency_key_reused" || err.code === "checkout_abandoned")) {
        clearCheckout(checkoutKey);
      }
      setPlaceError(err.message);
    } finally {
      setPlacing(false);
    }
  };

  if (!tableId && !counterService) {
    return (
      <main className="page-narrow">
        <div className="state-card">
          <span className="state-emoji" aria-hidden="true">
            🪑
          </span>
          <h1>Which table are you at?</h1>
          <p className="muted">
            Scan the QR code on your table, or pick your table below to start an order.
          </p>
          <div className="table-grid">
            {tables.map((table) => (
              <button key={table.id} type="button" className="table-chip" onClick={() => pickTable(table.id)}>
                <span>{table.label}</span>
                <small>{table.seats} seats</small>
              </button>
            ))}
            {tables.length === 0 && !tablesError && <p className="muted small">Loading tables…</p>}
          </div>
          {tablesError && (
            <RetryNotice message={tablesError} onRetry={() => setTablesAttempt((n) => n + 1)} />
          )}
          {configError && <RetryNotice message={configError.message} onRetry={retryConfig} />}
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="page-narrow">
        <div className="state-card">
          <span className="state-emoji" aria-hidden="true">
            🫥
          </span>
          <h1>Hmm, that link didn't work</h1>
          <p className="muted">{error}</p>
          <button type="button" className="btn primary" onClick={() => setMenuAttempt((n) => n + 1)}>
            Try again
          </button>
          <Link className="btn" to={cafePath("")}>
            Back to the start
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="menu-page">
      <header className="menu-head">
        <div>
          <p className="eyebrow">{cafe}</p>
          <h1>Menu</h1>
        </div>
        <div className="table-badge">
          <span>{counterService ? "Pickup" : data && data.table ? data.table.label : `Table ${tableId}`}</span>
          <small>{counterService ? "order · pay · collect" : "scan · order · relax"}</small>
        </div>
      </header>

      {configError && <RetryNotice message={configError.message} onRetry={retryConfig} />}

      {!data && !error && <SkeletonMenu />}

      {data && (
        <>
          <nav className="category-nav" aria-label="Menu categories">
            {data.categories.map((category) => (
              <button
                key={category.name}
                type="button"
                onClick={() =>
                  document.getElementById(`cat-${slug(category.name)}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              >
                {category.name}
              </button>
            ))}
          </nav>

          <div className="menu-sections">
            {data.categories.map((category) => (
              <section key={category.name} id={`cat-${slug(category.name)}`} className="menu-section">
                <h2>{category.name}</h2>
                <ul className="menu-list">
                  {category.items.map((item) => (
                    <li key={item.id} className={`menu-item${item.available ? "" : " sold-out"}`}>
                      <span className="menu-emoji" aria-hidden="true">
                        {item.emoji}
                      </span>
                      <div className="menu-text">
                        <div className="menu-title">
                          <h3>{item.name}</h3>
                          <span className="menu-price">{money(item.priceCents)}</span>
                        </div>
                        <p className="muted small">{item.description}</p>
                        {!item.available && <span className="pill sold">Sold out</span>}
                      </div>
                      {item.available &&
                        (cart[item.id] ? (
                          <div className="stepper">
                            <button
                              type="button"
                              onClick={() => setQty(item.id, (cart[item.id] || 0) - 1)}
                              aria-label={`Remove one ${item.name}`}
                            >
                              −
                            </button>
                            <span>{cart[item.id]}</span>
                            <button
                              type="button"
                              onClick={() => setQty(item.id, (cart[item.id] || 0) + 1)}
                              aria-label={`Add one ${item.name}`}
                            >
                              +
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="add-btn"
                            onClick={() => setQty(item.id, 1)}
                            aria-label={`Add ${item.name} to your order`}
                          >
                            +
                          </button>
                        ))}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}

      {itemCount > 0 && (
        <div className="cart-bar-wrap">
          <button type="button" className="cart-bar" onClick={() => setSheetOpen(true)}>
            <span className="cart-count">{itemCount}</span>
            <span className="cart-label">{itemCount === 1 ? "item" : "items"} in your order</span>
            <span className="cart-total">{money(total)}</span>
            <span className="cart-arrow" aria-hidden="true">
              →
            </span>
          </button>
        </div>
      )}

      {resolvedOrder && (
        <div className="state-card" role="status">
          <p>
            Your earlier order was already placed — <strong>#{resolvedOrder.id}</strong>
            {resolvedOrder.queueNo != null ? ` · pickup number ${resolvedOrder.queueNo}` : ""}.
          </p>
          <p className="muted small">Your new items are still in the cart below.</p>
          <button
            type="button"
            onClick={() =>
              navigate(orderLink(resolvedOrder, resolvedOrder.trackToken, tableId))
            }
          >
            Open order #{resolvedOrder.id}
          </button>
        </div>
      )}

      <CartSheet
        open={sheetOpen}
        lines={lines}
        note={note}
        onNote={setNote}
        onQty={setQty}
        onClose={() => setSheetOpen(false)}
        onPlace={placeOrder}
        total={total}
        placing={placing}
        error={placeError}
        tableLabel={counterService ? "Pickup order" : data && data.table ? data.table.label : `Table ${tableId}`}
      />
    </main>
  );
}

function RetryNotice({ message, onRetry }) {
  return (
    <div className="alert" role="alert">
      <p>{message}</p>
      <button type="button" className="btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function readCart(cartKey) {
  try {
    const raw = localStorage.getItem(cartKey);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function SkeletonMenu() {
  return (
    <div className="menu-sections" aria-hidden="true">
      {[0, 1].map((section) => (
        <div key={section} className="menu-section">
          <div className="skeleton-line w-30" />
          <ul className="menu-list">
            {[0, 1, 2].map((row) => (
              <li key={row} className="menu-item">
                <span className="menu-emoji skeleton" />
                <div className="menu-text">
                  <div className="skeleton-line w-60" />
                  <div className="skeleton-line w-90" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
