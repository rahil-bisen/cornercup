import { useEffect, useRef, useState } from "react";
import { money } from "../lib/money.js";

// The sheet is mounted only while it is open, so its focus work belongs in a component that exists for
// exactly that lifetime: moving focus in on open and returning it to whatever opened the sheet (the cart
// bar) on close, including the close that comes from Escape or a backdrop tap.
export default function CartSheet(props) {
  if (!props.open) return null;
  return <OpenCartSheet {...props} />;
}

function OpenCartSheet({
  lines,
  note,
  onNote,
  // Per-dish notes, keyed by item id, and their setter.
  itemNotes = {},
  onItemNote = () => {},
  onQty,
  onClose,
  onPlace,
  total,
  placing,
  error,
  tableLabel,
  // True only when this café reports a live payment gateway, so the copy never promises an online
  // checkout that the deployment cannot take.
  payOnline = false,
  // True when the server has said it cannot accept orders, so the guest learns it before sending.
  orderingClosed = false,
  orderingClosedMessage = "",
}) {
  const sheetRef = useRef(null);
  // Which line's note field is open. A line that already has a note shows its field from the start.
  const [editingNote, setEditingNote] = useState(null);
  const itemCount = lines.reduce((sum, line) => sum + line.qty, 0);
  const closeRef = useRef(null);
  const restoreRef = useRef(null);
  // The callbacks are read through refs so the effect below runs once per open, not once per render:
  // a new onClose identity on every parent render would otherwise pull focus back to the close button
  // while the guest is typing a note.
  const onCloseRef = useRef(onClose);
  const placingRef = useRef(placing);
  onCloseRef.current = onClose;
  placingRef.current = placing;

  useEffect(() => {
    const opener = document.activeElement;
    restoreRef.current = opener;

    // Everything beside the dialog — the menu behind it, the cart bar it was opened from — is made
    // inert while the sheet is open, so a screen reader or a stray click cannot reach it. Only siblings
    // of the dialog's own ancestors are marked, never an ancestor and never the dialog, or the sheet
    // would take itself out of the accessibility tree. Whatever was already inert is left alone.
    const inerted = [];
    for (let node = sheetRef.current; node && node !== document.body; node = node.parentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node) continue;
        if (sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
        if (sibling.hasAttribute("inert")) continue;
        sibling.setAttribute("inert", "");
        inerted.push(sibling);
      }
    }

    if (closeRef.current) closeRef.current.focus();

    const onKeyDown = (event) => {
      // Escape closes the sheet, but never while the order is being sent: the reply is what decides
      // whether the cart is cleared, and a guest who dismissed the sheet here would lose that answer.
      if (event.key === "Escape") {
        if (placingRef.current) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusable = sheet.querySelectorAll(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Un-inert before moving focus back: an inert opener cannot receive it.
      inerted.forEach((element) => element.removeAttribute("inert"));
      const target = restoreRef.current;
      // A remount of the page (or a fired navigation) may have removed the opener already.
      if (target && typeof target.focus === "function" && document.contains(target)) target.focus();
    };
  }, []);

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-sheet-title"
        ref={sheetRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-grip" />
        <header className="sheet-head">
          <div>
            <p className="eyebrow">Your order</p>
            <h2 id="cart-sheet-title">{tableLabel}</h2>
          </div>
          <button type="button" className="icon-btn" ref={closeRef} onClick={onClose} aria-label="Close order">
            ✕
          </button>
        </header>

        <div className="sheet-body">
          <p className="sheet-summary">
            {itemCount} {itemCount === 1 ? "item" : "items"} · check your order before sending it
          </p>
          <ul className="sheet-lines">
            {lines.map((line) => {
              const id = line.item.id;
              const itemNote = itemNotes[id] || "";
              const noteOpen = editingNote === id || Boolean(itemNote);
              const noteField = `item-note-${id}`;
              return (
              <li key={id} className="sheet-line">
                <div className="sheet-line-text">
                  <p className="sheet-line-name">{line.item.name}</p>
                  {/* The unit price only earns its line when there is more than one; at a quantity of
                      one it would repeat the line total word for word. */}
                  {line.qty > 1 && <p className="muted small">{money(line.item.priceCents)} each</p>}
                  {noteOpen ? (
                    <label className="sheet-item-note" htmlFor={noteField}>
                      <span className="sr-only">Note for {line.item.name}</span>
                      <input
                        id={noteField}
                        type="text"
                        maxLength={120}
                        autoComplete="off"
                        placeholder="e.g. less sugar, no onion"
                        value={itemNote}
                        autoFocus={editingNote === id && !itemNote}
                        onChange={(event) => onItemNote(id, event.target.value)}
                        onBlur={() => {
                          if (!itemNote.trim()) setEditingNote(null);
                        }}
                      />
                    </label>
                  ) : (
                    <button type="button" className="link-btn sheet-add-note" onClick={() => setEditingNote(id)}>
                      + Add a note
                    </button>
                  )}
                </div>
                <div className="stepper">
                  <button
                    type="button"
                    onClick={() => onQty(line.item.id, line.qty - 1)}
                    aria-label={`Remove one ${line.item.name}`}
                  >
                    −
                  </button>
                  <span aria-live="polite">{line.qty}</span>
                  <button
                    type="button"
                    onClick={() => onQty(line.item.id, line.qty + 1)}
                    aria-label={`Add one ${line.item.name}`}
                  >
                    +
                  </button>
                </div>
                <span className="sheet-line-price">{money(line.item.priceCents * line.qty)}</span>
              </li>
              );
            })}
          </ul>

          <label className="field">
            <span>Anything else the kitchen should know? (optional)</span>
            <textarea
              rows={2}
              maxLength={300}
              placeholder="Allergies, or anything for the whole order"
              value={note}
              onChange={(event) => onNote(event.target.value)}
            />
          </label>

          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="sheet-foot">
          {/* The reassurance sits above the action, so the button a thumb aims for is the last thing
              in the sheet and the first thing kept when the on-screen keyboard eats the height. */}
          {orderingClosed ? (
            <p className="alert" role="status">
              {orderingClosedMessage}
            </p>
          ) : (
            <p className="muted small center">
              {payOnline
                ? "Pay on the next screen — no queue at the counter."
                : "Pay at the counter when you collect — card, cash or UPI."}
            </p>
          )}
          <div className="sheet-total">
            <span className="muted">Total</span>
            <strong>{money(total)}</strong>
          </div>
          <button type="button" className="btn primary" onClick={onPlace} disabled={placing || lines.length === 0 || orderingClosed}>
            {placing ? "Sending…" : payOnline ? "Send order & pay" : "Send order"}
          </button>
          <button type="button" className="link-btn center-self" onClick={onClose}>
            Add more items
          </button>
        </footer>
      </div>
    </div>
  );
}
