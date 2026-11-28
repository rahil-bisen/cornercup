// The Indian food-type mark: a square outline with a symbol inside. Veg is green with a dot, non-veg is
// red with a triangle and egg is brown with a dot. The shape differs as well as the colour, so the mark
// still reads for a guest who cannot tell red from green, and screen readers hear the words.
const LABELS = {
  veg: "Vegetarian",
  nonveg: "Non-vegetarian",
  egg: "Contains egg",
};

export function dietLabel(diet) {
  return LABELS[diet] || "";
}

export default function DietMark({ diet }) {
  const label = LABELS[diet];
  if (!label) return null;
  return (
    <span className={`diet-mark diet-${diet}`} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        {diet === "nonveg" ? (
          <path d="M8 4.2 L12 11.2 H4 Z" fill="currentColor" />
        ) : (
          <circle cx="8" cy="8" r="3.4" fill="currentColor" />
        )}
      </svg>
    </span>
  );
}
