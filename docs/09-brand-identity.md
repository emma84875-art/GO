# Brand identity: proposals for approval

Status: **Proposals for owner review. Nothing is final.** The approved palette is confirmed below. The two neutral colours and the logo are proposals.

Files:
- `packages/ui/src/tokens.css`: colour and type tokens, light and dark themes
- `brand/logo-mark-navy.svg`, `brand/logo-mark-porcelain.svg`: first-pass mark (**not recommended**, see below)
- `brand/concepts/alt-a-g-monogram.svg`, `brand/concepts/alt-b-gateway-arch.svg`, `brand/concepts/alt-c-route-points.svg`: alternative concepts

---

## 1. Approved palette (unchanged)

| Name | Hex | Role |
|---|---|---|
| Midnight Navy | `#142B3D` | Primary text (light), background (dark) |
| Deep Teal | `#006B64` | Primary action and links (light) |
| Sea Glass | `#72D6C8` | Primary action and accents (dark), fills and highlights (light) |
| Champagne | `#B68D5D` | Signature accent, decorative and non-text on light; text allowed on the dark background only |
| Porcelain | `#F6F7F5` | Background (light), primary text (dark) |

Typography: Inter, with system fallbacks. Light and dark themes, following the operating system by default, with a saved override.

---

## 2. Neutral colours for approval

Two colours are outside the approved palette. They are needed so cards and surfaces have contrast. These are the exact proposals:

| Token | Proposed hex | Used for | Contrast |
|---|---|---|---|
| Light surface (cards, panels) | `#FFFFFF` | Card background on light theme | Navy text on white: **14.56:1** (AA pass). Deep Teal text on white: **6.39:1** (AA pass) |
| Dark surface (cards, panels) | `#1B3749` | Card background on dark theme | Porcelain text on `#1B3749`: **11.57:1** (AA pass). Sea Glass on `#1B3749`: **7.20:1** (AA pass). Champagne on `#1B3749`: **4.12:1** (fails AA for text, so no text in Champagne on cards) |

**Recommendation:** approve both. Without a dark surface, dark-theme cards would sit on the Midnight Navy background with no separation. `#1B3749` is a lightened Midnight Navy, so it stays in the same family. `#FFFFFF` is the standard light surface.

---

## 3. Logo: the first pass is not recommended

The first-pass mark is a Sea Glass arc from a Porcelain dot to a Champagne dot, on a Midnight Navy tile.

**It fails the owner's standard:**
- At 16 and 24 pixels the two dots disappear, and the arc reads as a generic trend or curve icon.
- It is not distinctive. A curved line on a tile is a common icon style.

I tested it at 256, 64, 32, 24 and 16 pixels. It is withdrawn.

---

## 4. Alternatives (tested at 256, 64, 32 and 16 pixels)

All three use the approved palette, one tile shape (rounded square, radius 16 of 64), and no detail smaller than about 4 pixels at 64.

### Concept A: monogram G with departure terminal

- Sea Glass ring with a gap at upper right, a Sea Glass crossbar, and a Champagne dot at the gap.
- **Reads clearly as a G at every size.** The gap makes it a departure point.
- **Concern:** the Sea Glass ring and crossbar strongly resemble the widely used "G" of a large search company. A G monogram is also the most common letter mark. This is a **trademark and originality risk**, and it would need a similarity search before use.
- File: `brand/concepts/alt-a-g-monogram.svg`

### Concept B: gateway arch with departure line (recommended)

- Porcelain arch (a doorway or gateway, which suits international travel), a Sea Glass departure line from inside the arch to the upper right, and a Champagne point beyond it.
- **Distinctive**: a doorway with a departure line is not a letter or a common travel symbol.
- **Recognisable at 16 pixels**: the arch and line remain readable, and the Champagne point is enlarged to 6 units to survive small sizes.
- **Concern:** an arch is a common architectural motif, so it still needs a trademark similarity search.
- File: `brand/concepts/alt-b-gateway-arch.svg`

### Concept C: two points on a route

- Porcelain dot at origin, Champagne square at destination, and a dotted Sea Glass route between them.
- **Fails at small sizes**: the dotted route turns into noise at 16 and 24 pixels.
- **Concern:** a dotted route between two points is common in mapping and logistics.
- File: `brand/concepts/alt-c-route-points.svg`

### Assessment

| Test | A: G monogram | B: gateway arch | C: route points |
|---|---|---|---|
| Distinctive | Medium: common letter form | High | Low: common mapping motif |
| Recognisable at 16 px | Yes | Yes (with enlarged point) | No |
| Original (no close resemblance) | **At risk**: resembles a major search brand's G | Probable, subject to search | Probable, subject to search |
| Fits "international, trustworthy, minimalist" | Yes | Yes | Partly |

**Recommendation: Concept B**, subject to a trademark and similarity search by counsel.

---

## 5. Open items

1. **Approve or amend the two neutral colours** (section 2).
2. **Choose a logo direction**: B recommended; A is available only if the owner accepts the resemblance risk; C is not recommended.
3. **Product name**: "GO" is a working title. It is common, and it needs a trademark search by Nigerian counsel. A name that is more distinctive would also help the logo.
4. **Wordmark**: not yet designed. It needs the final name, Inter converted to outlines, and a check at small sizes.
5. **Trademark and similarity searches** for the final name and the chosen mark (tracked in `docs/10`).
