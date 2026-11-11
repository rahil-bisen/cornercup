import { money } from "../lib/money.js";

export default function CartSheet({
  open,
  lines,
  note,
  onNote,
  onQty,
  onClose,
  onPlace,
  total,
  placing,
  error,
  tableLabel,
}) {
  if (!open) return null;

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Your order"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-grip" />
        <header className="sheet-head">
          <div>
            <p className="eyebrow">Your order</p>
            <h2>{tableLabel}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close order">
            ✕
          </button>
        </header>

        <div className="sheet-body">
          <ul className="sheet-lines">
            {lines.map((line) => (
              <li key={line.item.id} className="sheet-line">
                <span className="sheet-emoji" aria-hidden="true">
                  {line.item.emoji}
                </span>
                <div className="sheet-line-text">
                  <p className="sheet-line-name">{line.item.name}</p>
                  <p className="muted small">{money(line.item.priceCents)} each</p>
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
            ))}
          </ul>

          <label className="field">
            <span>Anything the kitchen should know?</span>
            <textarea
              rows={2}
              maxLength={300}
              placeholder="No onions, extra hot, allergy notes…"
              value={note}
              onChange={(event) => onNote(event.target.value)}
            />
          </label>

          {error && <p className="alert">{error}</p>}
        </div>

        <footer className="sheet-foot">
          <div className="sheet-total">
            <span className="muted">Total</span>
            <strong>{money(total)}</strong>
          </div>
          <button type="button" className="btn primary" onClick={onPlace} disabled={placing || lines.length === 0}>
            {placing ? "Sending…" : "Send order & pay"}
          </button>
          <p className="muted small center">Pay on the next screen — no queue at the counter.</p>
        </footer>
      </div>
    </div>
  );
}
