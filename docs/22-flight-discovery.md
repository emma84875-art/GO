# 22. Flight discovery (Phase 17)

Date: 24 Nov 2026
Status: customer-facing discovery built and tested in the static web app. Live fares are NOT connected.
Nothing committed, pushed or deployed. Payments, ticketing, crypto and passport collection remain off.

## 1. What works today (static app, no server)

| Area | What the customer gets | Evidence |
|---|---|---|
| Homepage | Value proposition, search form as the main focus, benefits, popular destinations from Lagos, "before you travel" guidance, support placeholder | Browser checks, light and dark, phone and desktop |
| Search form | One-way and return; from and to airports with keyboard autocomplete; departure and return dates; adults, children and infants; four cabin classes; currency choice; multi-city shown as "not available yet" | Browser checks; `flights.test.js` |
| Validation | Inline messages per field, a summary that takes focus, and the same rules as the server (shared code, parity-tested) | Browser checks; parity test against the TypeScript validator |
| Shareable searches | Search details and sort or filter choices live in the URL, so a refresh keeps them | `flights.test.js` (routes, options) |
| Unavailable state | With no search service connected, the page says so and shows no fares, examples or estimates | Browser checks (no result cards rendered) |
| Results view (ready) | Airline code, flight numbers, departure and arrival times in airport local time, "+1 day" marks, duration, stops with connection airports, baggage and fare conditions, one total fare with its validity time; sort by price, duration or departure; filter by stops, airline, departure window and checked bag | Unit tests; browser checks with synthetic offers in a test copy only |
| Unconfirmed details | Any detail the airline did not confirm reads "not confirmed by the airline", never "none" | Unit tests; browser checks |
| Booking | Button shown disabled: "Booking is not available yet". No payment, ticket or passport form exists | Browser scan of the build |

## 2. What needs a server-side search API

The static site has no runtime and cannot hold a secret. Anything that calls a supplier needs a server:

- Live or sandbox fares from Duffel (or any other supplier).
- Any supplier token, key or account setting.
- Rate limiting of supplier calls, caching, and logging of supplier errors.
- Holds, orders, payments and ticketing (all out of scope and disabled).

The browser never calls a supplier. The shipped `config.js` has `FLIGHT_SEARCH_ENDPOINT: null`, so no request is made.

## 3. How the existing flight-search package connects to a backend

The package `packages/flights` already contains the server logic. It is reused, not copied:

1. `search.ts` validates a search and maps it to a supplier request. `runFlightSearch` in `search-service.ts` returns one of four explicit outcomes: ok, empty, invalid or unavailable.
2. `adapters/duffel.ts` implements the supplier interface. It throws `SupplierUnavailableError` with a reason code when credentials are missing or the provider fails. No response is invented.
3. The browser build copies only `search.ts`, `airports.ts`, `offer-filters.ts`, `search-service.ts`, `supplier.ts` and the `core` helpers it needs (`scripts/vendor-web.mjs`). Adapters are excluded, and the build refuses any adapter code or provider endpoint in browser output.

Planned server entry point (not built):

- `POST /api/flights/search` takes the `SearchRequest` JSON the browser already sends.
- It validates the request again with the same `validateSearch`, calls `runFlightSearch` with the Duffel adapter, and returns `{ "offers": [...], "source": { "name", "mode" } }`.
- Error mapping: `not_configured` and `production_not_approved` return 503 with a reason code; `timeout` returns 504; `provider_error` returns 502; `invalid_response` returns 502. The browser maps these to the messages it already shows.
- Only offers that pass the browser's shape check reach the page. Malformed offers are dropped.

## 4. Duffel credentials

- `DUFFEL_ACCESS_TOKEN` is set as a secret environment variable on the search service only.
- It is never placed in the repository, `config.js`, the static build, client logs, error messages or chat.
- Sandbox first. Production stays refused unless `productionApproved` is set by the owner after a signed supplier agreement (existing rule in the adapter).
- Duffel account approval and the Nigeria sign-up question are still open (`docs/05`). No live credential has been requested or used.

## 5. Infrastructure and configuration required

| Item | Requirement | Status |
|---|---|---|
| Search service | A Node 22 web service from this repo, separate from the static site. Health check route. No public write routes | Not built |
| Static site | Unchanged: Render static site, build `npm run build:web`, publish `apps/web/dist` | Live (staging) |
| CORS | Exact allowlist of the static site origin only (`packages/http` baseline) | Not configured |
| CSP | Add the search service origin to `connect-src` in `index.html` (currently Supabase only). Keep `default-src 'none'` | Not changed |
| `FLIGHT_SEARCH_ENDPOINT` | Absolute HTTPS URL of the search service, set in `config.js` at build time | Null |
| Rate limiting | Per-address fixed window from `packages/http`. In memory: one instance only | Code exists, not wired |
| Logging | Search route and time only. No traveller names, dates of birth or document numbers. Errors without provider bodies | Not built |
| Secrets | `DUFFEL_ACCESS_TOKEN` as a Render secret on the search service | Not set (no approved credential) |
| Cost | A continuously running Render web service is a paid item. Free instances sleep, which would slow the first search. Needs owner approval (zero-capital rule) | Decision |

## 6. Should the current architecture be extended?

Recommendation: add a dedicated thin search service, not extend the static site.

- Reason: the static site cannot hold secrets, has no request handling, and must stay free of supplier code. A separate service keeps those boundaries.
- Same code and language: the service runs the existing TypeScript package on Node 22, so validation, mapping and error handling are tested once.
- Hosting: Render, which already hosts staging. A Supabase Edge Function was considered. It would run a second runtime (Deno), split the TypeScript packages, and add cold-start and quota questions, so it is not recommended for this step.
- Scope limit: the search service only searches. Holds, orders, payments and tickets need their own review and stay disabled.

## 7. Known limitations

- Airport list: 10 development fixture airports only. A complete licensed or public IATA dataset is needed before launch (`docs/07`).
- No live or sandbox results yet. The results view was tested only with synthetic data in a test copy.
- Multi-city search is supported: two to six journeys in travel order, through the shared search contract (see docs/23). The airport list is still the 10-airport fixture.
- Currency: GO does not convert prices. A fare stays in the currency the airline sells it in, is labelled with that currency, and carries a note when it differs from the requested currency. A conversion is used only with a fresh FX snapshot for that pair, and no FX source is connected.
- Accessibility: keyboard and labelling were checked in headless Chromium. A screen-reader pass is not done.
- Derived palette shades (error surfaces and the dark background) await owner approval (`packages/ui/src/tokens.css`).
- Support contact details are not published.
- The browser checks ran against a local server, not the Render staging site. The staging deploy is not updated.

## 8. Decisions for the owner

- [ ] Approve a dedicated search service on Render, and its monthly cost (or a free instance that sleeps).
- [ ] Approve a Duffel sandbox credential for that service (sign-up and Nigeria eligibility still open, `docs/05`).
- [ ] Approve the derived error and dark-mode shades in `apps/web/src/styles.css`.
- [ ] Approve or supply a complete airport dataset source and its licence.
- [ ] Decide whether multi-city search is needed before launch, since it changes the shared search contract.
- [ ] Decide the public support channel and contact details.
