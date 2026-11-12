# Brand identity (first pass)

Status: **First pass for review.** Files are in `brand/` and `packages/ui/src/tokens.css`. The product name is not final (see "Name" below).

## Direction

Minimalist, sophisticated, international and trustworthy. Calm rather than loud. Generous space, a restrained palette, and one signature detail (the flight arc) rather than decoration.

We deliberately avoid the visual language of Expedia, Wakanow and Booking.com: no orange or blue-heavy call-to-action palettes, no bright promotional banners, no "deal" styling, and no imitation of their logos or layouts.

## Palette

| Name | Hex | Role |
|---|---|---|
| Midnight Navy | `#142B3D` | Primary text (light), background (dark) |
| Deep Teal | `#006B64` | Primary action and links (light) |
| Sea Glass | `#72D6C8` | Primary action and accents (dark), highlights (light) |
| Champagne | `#B68D5D` | Signature detail, decorative accents |
| Porcelain | `#F6F7F5` | Background (light), primary text (dark) |

Typography: **Inter** throughout, with system fallbacks.

## Contrast (WCAG 2.x, checked)

Passing pairs for body text and controls are marked. Ratios under 4.5:1 are not used for text.

| Use | Foreground on background | Ratio | Result |
|---|---|---|---|
| Light body text | Navy on Porcelain | 13.55:1 | AA pass |
| Light primary button | Porcelain on Deep Teal | 5.94:1 | AA pass |
| Light links | Deep Teal on Porcelain | 5.94:1 | AA pass |
| Light links on white surface | Deep Teal on white | 6.39:1 | AA pass |
| Dark body text | Porcelain on Navy | 13.55:1 | AA pass |
| Dark body text on card surface | Porcelain on `#1B3749` | 11.57:1 | AA pass |
| Dark primary and links | Sea Glass on Navy | 8.43:1 | AA pass |
| Dark primary button | Navy on Sea Glass | 8.43:1 | AA pass |
| Champagne text on dark background | Champagne on Navy | 4.82:1 | AA pass (normal text) |
| Champagne text on light background | Champagne on Porcelain | 2.81:1 | **Fails. Decorative only.** |
| Champagne text on dark card surface | Champagne on `#1B3749` | 4.12:1 | **Fails. Not for text on surfaces.** |
| Deep Teal text on dark background | Deep Teal on Navy | 2.28:1 | **Fails. Not used.** |

Two colours are not in the brand palette: `#FFFFFF` (light surface) and `#1B3749` (dark surface). They are neutral extensions chosen to keep the contrast ratios above. The owner should confirm them.

## Theme behaviour

- Light and dark themes are defined in `packages/ui/src/tokens.css`.
- By default the theme follows the operating system setting.
- A `data-theme` attribute on the page root overrides it, so a customer's choice can be saved.
- Focus rings use a visible colour in both themes.

## Logo

Two versions of the brand mark, in `brand/`:

- `brand/logo-mark-navy.svg`: navy tile, sea-glass arc, champagne arrival point. For light backgrounds.
- `brand/logo-mark-porcelain.svg`: porcelain tile, navy arc, teal departure point and champagne arrival point. For dark or photographic backgrounds.

**Concept:** a single flight arc from a departure point to an arrival point, with the arrival marked in champagne. It stands for a journey that starts in Nigeria and reaches the world, and it avoids the usual globe, plane silhouette or map cliché.

**Not yet done:** a wordmark. The wordmark needs Inter converted to outlines, which must be done with a font tool so the logo does not depend on the font being installed. This also needs the final product name.

## Name

The repository is called "GO", and the README calls it "a global travel platform". "GO" is a very common word and name, so it is probably not registrable as a trademark and is unlikely to stand out in search.

**Before any public use, the name needs a trademark clearance search** in Nigeria (Trademarks Registry) and in the markets we plan to enter, by qualified counsel. Until then, treat "GO" as a working title.

## Decisions needed

1. Confirm the two extra neutral colours (`#FFFFFF`, `#1B3749`).
2. Confirm the product name, and whether we need a wordmark.
3. Confirm the logo concept, or ask for alternatives.
4. Commission a trademark search on the final name.
