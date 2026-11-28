import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, cafePath, cafeSlug } from "../lib/api.js";
import { cafeName, isCafeNotFound, useCafeTitle, useSiteConfigState } from "../lib/config.js";
import CafeNotFound from "../components/CafeNotFound.jsx";
import { isCurrentScope, menuScope } from "../lib/menuScope.js";
import { placeholderInitial, resolveItemImage } from "../lib/menuImages.js";
import { filterMenu, searchUseful, vegFilterUseful } from "../lib/menuFilter.js";
import DietMark from "../components/DietMark.jsx";
import { money } from "../lib/money.js";
import { checkoutPaymentMethod, gatewayEnabled } from "../lib/payments.js";
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
  const { config, error: configError, retry: retryConfig } = useSiteConfigState();
  const cafe = cafeName(config);
  useCafeTitle(config, "Menu", isCafeNotFound(configError));
  // Set by the café (SERVICE_MODE=counter): no table to scan, the guest gets a pickup number instead.
  const counterService = Boolean(config && config.service && config.service.mode === "counter");
  // Tables are remembered per café: two outlets sharing a browser must never borrow each other's table.
  const tableStorageKey = `cafe_table:${cafeKey}`;
  // The QR code carries the table in the path; ?table=N is accepted too. Either way it is kept for
  // the session, so a refresh or a detour to a policy page doesn't lose the table before checkout.
  // Only the URL is trusted up front — a remembered table is restored after the service mode is known.
  const [tableId, setTableId] = useState(() => (linkTable ? String(linkTable) : ""));
  // The table this order is for. Always empty in a counter café: a table QR printed before the café
  // switched to pickup still opens /t/<n>, and the server rejects a tableId for a counter café, so such a
  // visit becomes a plain pickup order (no table in the menu request, the checkout, the cart or the link).
  const activeTable = counterService ? "" : tableId;
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
  const cartKey = `cart:${cafeKey}:${activeTable ? `table-${activeTable}` : "takeaway"}`;
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
  const [brokenImages, setBrokenImages] = useState(() => new Set());
  const markImageBroken = (src) => {
    if (!src) return;
    setBrokenImages((prev) => {
      if (prev.has(src)) return prev;
      const next = new Set(prev);
      next.add(src);
      return next;
    });
  };
  const resolveMenuImage = (item, category) => resolveItemImage(item, category, brokenImages);

  // The tracking token rides in the URL fragment: it is never sent to the server in a request line,
  // never reaches an access log, and browsers strip it from any Referer.
  function orderLink(order, token, table) {
    const path = cafePath(table ? `/t/${table}/order/${order.id}` : `/order/${order.id}`);
    return token ? `${path}#t=${encodeURIComponent(token)}` : path;
  }
  // In-app navigation to another café must not carry the previous café's table along. This is adjusted
  // during render rather than in an effect on purpose: an effect runs after the commit, which leaves one
  // render in which the new café is asked for the previous café's table — and the server answers an
  // unknown table with a 404, so the guest would see "we couldn't find that table" flash before the real
  // menu arrived. React re-runs the render before committing, so no request is ever made for that pass.
  const [tableCafe, setTableCafe] = useState(cafeKey);
  // Which section the guest is looking at, so the category rail can say where they are. It is only
  // ever moved by scrolling or by tapping a chip — never by a timer — and it resets with the café.
  const [activeCategory, setActiveCategory] = useState("");
  if (tableCafe !== cafeKey) {
    setTableCafe(cafeKey);
    setTableId(linkTable ? String(linkTable) : "");
    setTablesError("");
    setError("");
    setActiveCategory("");
  }

  // Everything a menu request depends on, as one value. It is the effect's dependency, so changing
  // café refetches even when the table number and the service mode stay identical.
  const menuScopeKey = menuScope({ cafeKey, tableId: activeTable, counterService });
  const data = isCurrentScope(menuState.scope, menuScopeKey) ? menuState.data : null;
  const tables = isCurrentScope(tablesState.scope, cafeKey) ? tablesState.rows : [];
  // A café that exists but has not added any items yet. Without this the page rendered its header over
  // an empty body, which reads as broken rather than "not ready".
  const menuEmpty = Boolean(data && !data.categories.some((category) => category.items.length > 0));
  // "Veg only" is offered only when the menu marks diets and has something that is not veg.
  const [vegOnly, setVegOnly] = useState(false);
  const showVegFilter = Boolean(data && vegFilterUseful(data.categories));
  // Search appears once the menu is long enough to need it (more than 15 items).
  const [query, setQuery] = useState("");
  const showSearch = Boolean(data && searchUseful(data.categories));
  const activeQuery = showSearch ? query : "";
  const visibleCategories = useMemo(
    () => (data ? filterMenu(data.categories, { vegOnly: showVegFilter && vegOnly, query: activeQuery }) : []),
    [data, vegOnly, showVegFilter, activeQuery]
  );
  const visibleCount = visibleCategories.reduce((count, category) => count + category.items.length, 0);
  const filtering = Boolean(activeQuery.trim()) || (showVegFilter && vegOnly);
  const clearFilters = () => {
    setQuery("");
    setVegOnly(false);
  };

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

  // Waits for the café's settings, like the table list above: until the service mode is known, a counter
  // café opened through an old table link would be asked for that table, which it may not have.
  const configSettled = Boolean(config || configError);
  useEffect(() => {
    if (!configSettled) return undefined;
    if (!activeTable && !counterService) return undefined;
    let alive = true;
    setError("");
    api(activeTable ? `/api/menu?table=${encodeURIComponent(activeTable)}` : "/api/menu")
      .then((payload) => {
        if (alive) setMenuState({ scope: menuScopeKey, data: payload });
      })
      .catch((err) => {
        if (alive && !(err && err.canceled)) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [menuScopeKey, menuAttempt, configSettled]);

  // Scroll-spy for the category rail. A section is "current" when its top has passed just under the
  // sticky rail, which is what the guest's eye uses too. A plain scroll listener is deliberate: it works
  // on the first paint and everywhere IntersectionObserver is missing, and it is throttled to one
  // measurement per animation frame.
  useEffect(() => {
    if (!data) return undefined;
    let timer = 0;
    const measure = () => {
      const rail = document.querySelector(".category-nav");
      const offset = (rail ? rail.getBoundingClientRect().height : 55) + 28;
      let current = visibleCategories.length ? visibleCategories[0].name : "";
      visibleCategories.forEach((category) => {
        const section = document.getElementById(sectionId(category.name));
        if (section && section.getBoundingClientRect().top <= offset) current = category.name;
      });
      // The last section can be too short to ever reach the line above the rail, so at the end of the
      // page it wins regardless — otherwise the rail would claim a section the guest has scrolled past.
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atEnd && visibleCategories.length) current = visibleCategories[visibleCategories.length - 1].name;
      setActiveCategory((previous) => (previous === current ? previous : current));
    };
    // A timer rather than requestAnimationFrame: frames stop being produced while a tab is hidden or
    // occluded, which used to leave the flag set and every later scroll unmeasured. A timer still runs,
    // and 80ms of coalescing is coarser than a frame and far cheaper than measuring every event.
    const request = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        measure();
      }, 80);
    };
    measure();
    window.addEventListener("scroll", request, { passive: true });
    window.addEventListener("resize", request);
    return () => {
      window.removeEventListener("scroll", request);
      window.removeEventListener("resize", request);
      if (timer) clearTimeout(timer);
    };
  }, [data, visibleCategories]);

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
  const checkoutKey = checkoutStorageKey(cafeSlug(), activeTable);

  // The café's own config decides the rail: online only when this deployment reports a live gateway,
  // otherwise pay-at-counter. Never a hardcoded default — see src/lib/payments.js.
  const payOnline = gatewayEnabled(config);
  // The server reports when it cannot take an order (no tracking key configured). Only an explicit
  // `false` closes checkout, so a config from an older Worker without the field keeps ordering open.
  const orderingClosed = Boolean(config && config.ordering && config.ordering.available === false);

  const buildCheckoutPayload = () => ({
    ...(activeTable ? { tableId: Number(activeTable) } : {}),
    note,
    paymentMethod: checkoutPaymentMethod(config),
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
    if (!activeTable && !counterService) {
      setPlaceError("Pick your table first — the kitchen needs to know where to bring it.");
      return;
    }
    if (orderingClosed) {
      setPlaceError(ORDERING_CLOSED_MESSAGE);
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
      navigate(orderLink(payload.order, payload.trackToken, activeTable));
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

  // Everything that can stop the menu rendering is resolved into one failure with one retry. The café
  // itself comes first: until /api/config answers there is nothing to show a table picker for, and two
  // banners (tables + config) used to stack in the same card with two identical retries.
  const cafeFailed = Boolean(configError && !config);
  if (cafeFailed && isCafeNotFound(configError)) return <CafeNotFound />;
  const failure = cafeFailed
    ? {
        title: "We couldn't open this menu",
        message: configError.message,
        retry: () => {
          retryConfig();
          setTablesAttempt((n) => n + 1);
          setMenuAttempt((n) => n + 1);
        },
      }
    : error
      ? { title: "Hmm, that link didn't work", message: error, retry: () => setMenuAttempt((n) => n + 1) }
      : null;

  if (failure) {
    return (
      <main className="page-narrow">
        <div className="state-card">
          <span className="state-emoji" aria-hidden="true">
            🫥
          </span>
          <h1>{failure.title}</h1>
          <p className="muted">{failure.message}</p>
          <button type="button" className="btn primary" onClick={failure.retry}>
            Try again
          </button>
          <Link className="btn ghost" to={cafePath("")}>
            Back to the start
          </Link>
        </div>
      </main>
    );
  }

  // Until the café's settings arrive its name and service mode are unknown. Rendering anyway would show
  // the generic "Café" with a "Dine-in" badge, or ask a counter café's guest which table they are at,
  // and then flip. A neutral loading card is shown instead, as on the landing page.
  if (!config) {
    return (
      <main className="page-narrow">
        <div className="state-card" aria-busy="true">
          <span className="state-emoji" aria-hidden="true">
            ☕
          </span>
          <p className="muted">Loading…</p>
        </div>
      </main>
    );
  }

  if (!activeTable && !counterService) {
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
          {tables.length > 0 && (
            <div className="table-grid">
              {tables.map((table) => (
                <button key={table.id} type="button" className="table-chip" onClick={() => pickTable(table.id)}>
                  <span>{table.label}</span>
                  <small>{table.seats} seats</small>
                </button>
              ))}
            </div>
          )}
          {tables.length === 0 && !tablesError && <p className="muted small">Loading tables…</p>}
          {tablesError && <RetryNotice message={tablesError} onRetry={() => setTablesAttempt((n) => n + 1)} />}
        </div>
      </main>
    );
  }

  return (
    <main className="menu-page">
      <header className="menu-head">
        <span className="brand-mark small" aria-hidden="true">
          ☕
        </span>
        <div className="menu-head-text">
          <p className="eyebrow">{cafe}</p>
          <h1>Menu</h1>
        </div>
        <div className="table-badge">
          <span>{counterService ? "Pickup" : data && data.table ? data.table.label : `Table ${activeTable}`}</span>
          <small>{counterService ? "Counter service" : "Dine-in"}</small>
        </div>
      </header>

      {!data && !error && (
        <>
          <div className="category-nav-wrap">
            <div className="category-nav category-nav-skeleton" aria-hidden="true">
              {[0, 1, 2, 3].map((key) => (
                <span key={key} className="skeleton skeleton-pill" />
              ))}
            </div>
          </div>
          <SkeletonMenu />
        </>
      )}

      {data && menuEmpty && (
        <div className="state-card" role="status">
          <span className="state-emoji" aria-hidden="true">
            📋
          </span>
          <h2>Menu not available yet</h2>
          <p className="muted">
            {cafe} hasn&apos;t put its menu online yet. Please order with our staff for now — thank you for your
            patience.
          </p>
        </div>
      )}

      {data && !menuEmpty && (
        <>
          <div className="category-nav-wrap">
            <nav className="category-nav" aria-label="Menu categories">
              {visibleCategories.map((category) => {
                const current = activeCategory === category.name;
                return (
                  <button
                    key={category.name}
                    type="button"
                    className={current ? "active" : undefined}
                    aria-current={current ? "true" : undefined}
                    onClick={() => {
                      setActiveCategory(category.name);
                      document
                        .getElementById(sectionId(category.name))
                        ?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  >
                    {category.name}
                  </button>
                );
              })}
            </nav>
            <span className="category-nav-fade" aria-hidden="true" />
          </div>

          {(showSearch || showVegFilter) && (
            <div className="menu-tools">
              {showSearch && (
                <div className="menu-search">
                  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
                    <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
                    <path d="M13 13l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <input
                    type="search"
                    inputMode="search"
                    enterKeyHint="search"
                    autoComplete="off"
                    aria-label="Search the menu"
                    placeholder="Search the menu"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  {query && (
                    <button type="button" className="menu-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
                      ×
                    </button>
                  )}
                </div>
              )}
              {showVegFilter && (
                <label className={`veg-toggle${vegOnly ? " on" : ""}`}>
                  <input type="checkbox" checked={vegOnly} onChange={(event) => setVegOnly(event.target.checked)} />
                  <DietMark diet="veg" />
                  <span>Veg only</span>
                </label>
              )}
            </div>
          )}

          {/* Announced, so a screen-reader user hears how many dishes are left after typing. */}
          <p className="sr-only" role="status" aria-live="polite">
            {filtering ? `${visibleCount} ${visibleCount === 1 ? "item" : "items"} shown` : ""}
          </p>

          {visibleCategories.length === 0 && (
            <div className="state-card">
              <h2>Nothing matches</h2>
              <p className="muted">
                {activeQuery.trim() ? `No items match “${activeQuery.trim()}”.` : "No items on this menu match your filters."}
              </p>
              <button type="button" className="btn ghost" onClick={clearFilters}>
                Show the full menu
              </button>
            </div>
          )}

          <div className="menu-sections">
            {visibleCategories.map((category) => (
              <section key={category.name} id={sectionId(category.name)} className="menu-section">
                <h2>{category.name}</h2>
                <ul className="menu-list">
                  {category.items.map((item) => (
                    <li key={item.id} className={`menu-item${item.available ? "" : " sold-out"}`}>
                      {(() => {
                        const src = resolveMenuImage(item, category.name);
                        // A photograph is content, so it keeps real alt text; the placeholder is decoration.
                        if (!src) {
                          return (
                            <span className="menu-thumb menu-thumb-placeholder" aria-hidden="true">
                              {placeholderInitial(item)}
                            </span>
                          );
                        }
                        return (
                          <span className="menu-thumb">
                            <img
                              src={src}
                              alt={item.name}
                              width="72"
                              height="72"
                              loading="lazy"
                              decoding="async"
                              onError={() => markImageBroken(src)}
                            />
                          </span>
                        );
                      })()}
                      <div className="menu-text">
                        <div className="menu-title">
                          <h3 className="menu-name">
                            <DietMark diet={item.diet} />
                            {item.name}
                          </h3>
                          {!item.available && <span className="pill sold">Sold out</span>}
                        </div>
                        {item.description && <p className="menu-desc">{item.description}</p>}
                        <div className="menu-foot">
                          <span className="menu-price">{money(item.priceCents)}</span>
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
                        </div>
                      </div>
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
              navigate(orderLink(resolvedOrder, resolvedOrder.trackToken, activeTable))
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
        payOnline={payOnline}
        orderingClosed={orderingClosed}
        orderingClosedMessage={ORDERING_CLOSED_MESSAGE}
        tableLabel={counterService ? "Pickup order" : data && data.table ? data.table.label : `Table ${activeTable}`}
      />
    </main>
  );
}

const ORDERING_CLOSED_MESSAGE =
  "Ordering from your phone isn't available right now. Please order with our staff at the counter.";

function RetryNotice({ message, onRetry }) {
  return (
    <div className="alert" role="alert">
      <p>{message}</p>
      <button type="button" className="btn ghost small-btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

// Section ids are derived from the category name, so the rail and the sections can never disagree.
function sectionId(name) {
  return `cat-${slug(name)}`;
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
                <span className="menu-thumb skeleton" />
                <div className="menu-text">
                  <div className="skeleton-line w-60" />
                  <div className="skeleton-line w-90" />
                  <div className="skeleton-line w-30" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
