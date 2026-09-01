/**
 * Spendo - categories
 *
 * The n8n workflow had no categories, so its monthly report grouped by exact
 * description text and produced one "category" per typo. These are fixed, few, and
 * chosen to cover a month of ordinary spending without asking the user to think.
 *
 * `series` is the categorical colour slot from styles/tokens.css. Slots are assigned
 * here once, in order, and are never reassigned by rank: "Food" is series 1 whether
 * it is the biggest category this month or the smallest. A chart that repaints its
 * categories when the sort changes is lying about identity.
 *
 * Nine expense categories, eight slots. "Other" takes --series-other by design; a
 * ninth generated hue would be indistinguishable from an existing one under CVD.
 */

export const EXPENSE_CATEGORIES = [
  { id: 'food',      label: 'Food',          icon: 'fork-knife',      series: 1 },
  { id: 'transport', label: 'Transport',     icon: 'car',             series: 2 },
  { id: 'groceries', label: 'Groceries',     icon: 'shopping-cart',   series: 3 },
  { id: 'bills',     label: 'Bills',         icon: 'lightning',       series: 4 },
  { id: 'shopping',  label: 'Shopping',      icon: 'shopping-bag',    series: 5 },
  { id: 'health',    label: 'Health',        icon: 'first-aid-kit',   series: 6 },
  { id: 'rent',      label: 'Rent',          icon: 'house',           series: 7 },
  { id: 'fun',       label: 'Entertainment', icon: 'film-slate',      series: 8 },
  { id: 'other',     label: 'Other',         icon: 'dots-three-circle', series: 0 }
];

export const INCOME_CATEGORIES = [
  { id: 'salary',    label: 'Salary',        icon: 'briefcase',       series: 3 },
  { id: 'refund',    label: 'Refund',        icon: 'arrow-counter-clockwise', series: 1 },
  { id: 'gift',      label: 'Gift',          icon: 'gift',            series: 5 },
  { id: 'income',    label: 'Other income',  icon: 'coins',           series: 0 }
];

const BY_ID = new Map(
  [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES].map((c) => [c.id, c])
);

/** Never returns undefined: an unknown id renders as Other rather than as a blank row. */
export function category(id) {
  return BY_ID.get(id) || EXPENSE_CATEGORIES[EXPENSE_CATEGORIES.length - 1];
}

export function categoriesFor(direction) {
  return direction === 'in' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
}

export function defaultCategory(direction) {
  return direction === 'in' ? 'income' : 'food';
}

/** The CSS custom property backing a category's colour. Slot 0 is the folded tail. */
export function seriesVar(id) {
  const n = category(id).series;
  return n === 0 ? 'var(--series-other)' : `var(--series-${n})`;
}
