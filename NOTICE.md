# Third-party assets in Spendo

## Not third party

The app icon - `icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`,
`apple-touch-icon.png` and `favicon-32.png` - is the owner's own artwork. Nothing below
applies to it and it carries no attribution requirement.


## Icons

**Phosphor Icons** (`icons/sprite` inlined in `index.html`), MIT licence.
https://github.com/phosphor-icons/core

**Flaticon**, four raster glyphs used as CSS masks:

| File | Icon |
|---|---|
| `icons/bill.png` | bill |
| `icons/paid.png` | send money |
| `icons/received.png` | budgeting / receive money |
| `icons/rupee.png` | rupee |

These are used under the Flaticon free licence, which requires attribution to the
individual author of each icon.

**The attribution is not currently shown in the product.** It was a Credits section
in Settings and was removed at the owner's explicit request after the licence
requirement was pointed out. This file is where the obligation now lives, and it is
not a substitute for in-product attribution under that licence. Two ways to put it
right, whenever the owner wants to:

1. Restore a one-line credit at the foot of the Settings screen, naming each icon's
   author from its page on flaticon.com, or
2. Replace the four PNGs with Phosphor equivalents, which are MIT and need no
   in-product credit. `js/ui.js` reaches them through `imgIcon()`, and the CSS mask
   rules are `.icon-bill`, `.icon-paid`, `.icon-received` and `.icon-rupee` in
   `styles/app.css`.

## Type

**Geist**, SIL Open Font Licence 1.1. `fonts/geist-latin-variable.woff2`.
https://github.com/vercel/geist-font
