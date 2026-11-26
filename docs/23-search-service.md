# 23. Search service (Phase 18)

Status: built and tested locally. Not committed, pushed or deployed. Payments, ticketing, crypto and passport collection remain off. Staging stays on the Render free plan; there are no paid upgrades.

## 1. Architecture

```
Static site (Render static)            Search service (Render web, free)            Duffel (sandbox)
apps/web  -- POST JSON -->  apps/search  -- packages/flights (validation,  -->  api.duffel.com
(no secrets, no supplier code)          mapping, outcome) + packages/http     (token from env only)
```

- `apps/search` is a separate Node 22 service. It reuses `packages/flights` and `packages/http`; it does not copy them.
- The browser build contains none of the supplier adapters. `scripts/build-web.mjs` refuses supplier code and provider endpoints in browser output (checked on this build: none found).
- Every search is validated on the server with the same `validateSearch` the browser uses, before any supplier is called.

## 2. Endpoints

| Route | Auth | Response |
|---|---|---|
| `GET /health` | none | `200 {"status":"ok"}`. Gives no supplier or configuration detail. |
| `POST /api/flights/search` | none (public, opt-in cross-site, Origin must be listed) | See below. |

`POST /api/flights/search` takes one of three bodies:

- One-way: `{tripType:"one_way", origin, destination, departureDate, passengers, cabin, displayCurrency}`
- Return: as one-way, with `tripType:"round_trip"` and `returnDate`
- Multi-city: `{tripType:"multi_city", legs:[{origin,destination,departureDate}, ...], passengers, cabin, displayCurrency}`. Two to six legs, in travel order, each on or after the one before.

Responses:

| Status | Body | When |
|---|---|---|
| 200 | `{status:"ok", source, offers}` | Offers returned. `source` is `{name, mode}`. |
| 200 | `{status:"empty", source, offers:[]}` | The supplier found nothing. Not an error. |
| 422 | `{status:"invalid", errors}` | Shape or validation failed. Messages name fields; input is never echoed. |
| 503 | `{status:"unavailable", reason, source, message}` | `not_configured`, `production_not_approved` or `fx_unavailable`. |
| 504 | as above, `reason:"timeout"` | The provider did not answer in time. |
| 502 | as above, `reason` `provider_error` or `invalid_response` | Provider failed or returned something unusable. |
| 500 | `{error:"internal_error"}` | Unexpected fault. No details. |

`message` is always a fixed sentence chosen by the service. A provider's own text, a stack trace or a token never reaches the browser.

## 3. Security controls

- Request validation: a strict parser refuses unknown fields (reported only as `unknownField`), non-plain objects, out-of-range counts and oversized strings; then `validateSearch` checks the meaning.
- Body limit: 16 KiB by default (413 above it). Bad JSON gets 400.
- Rate limit: fixed window per socket address, 30 requests per 60 seconds by default. `GET /health` is not counted, so platform probes cannot trip it. The table holds at most 50,000 addresses; when it is full, a new address is refused until expired windows are removed. Counts are held in memory in one process. X-Forwarded-For is never read, so a client cannot choose its own address. Limitation: behind Render, the socket address is the platform's proxy, so all users may share one bucket. Staging therefore runs as one instance, and the limit should be read as a shared staging limit, not a per-user one (see section 9).
- CORS: exact origins from `SEARCH_ALLOWED_ORIGINS`. No wildcard, and an unlisted origin is never reflected. The service sends no `Access-Control-Allow-Credentials` on any route (both routes set `credentials: false`), because nothing in it uses cookies or Authorization. CORS is not authentication: it only tells browsers which sites may read responses, and anyone can call the endpoint directly.
- CSRF: the search route is public, holds no cookie session and sends no credentials. It is the only route that opts in to accepting the cross-site request the static site makes (`crossSite: true` in `packages/http`). The Origin rule still applies. A test confirms the opt-in does not extend to other routes.
- Timeouts: the Duffel adapter aborts after `SEARCH_SUPPLIER_TIMEOUT_MS`, and the timer runs until the response body has been read, so a slow body is also a timeout. A second deadline in the service also answers 504 if a transport ignores the abort signal (tested).
- Errors: any non-supplier exception from a supplier becomes `provider_error`; anything unexpected becomes a generic 500.
- Headers: CSP `default-src 'none'`, `X-Frame-Options: DENY`, `Cache-Control: no-store`, HSTS when https.
- Logging: one JSON line per request with a closed field set (`time, service, event, route, status, outcome, reason, durationMs`). The logger's type does not allow bodies, search details, offers, names or tokens. Tests check that a token never appears in logs or responses.
- Config errors name the variable, never its value.

## 4. Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SEARCH_ALLOWED_ORIGINS` | yes | none | Exact origin(s) of the static site, e.g. `https://<static-site>.onrender.com`. Comma-separated. No wildcard, path, query or trailing slash. https only (except `localhost` with the next variable). |
| `SEARCH_ALLOW_LOCAL_ORIGINS` | no | `false` | `true` allows `http://localhost` and `http://127.0.0.1` origins. Local development only. Never set on Render. |
| `SEARCH_HTTPS` | no | `true` | `false` removes HSTS for local runs. |
| `SEARCH_SUPPLIER` | no | `none` | `none` = not connected (every search answers 503 `not_configured`, no network call). `duffel` = Duffel sandbox adapter. |
| `DUFFEL_ACCESS_TOKEN` | when `SEARCH_SUPPLIER=duffel` | none | A Duffel **test** token, which starts with `duffel_test_`. Secret. Any other value, including a live token, stops the service at start-up with a message that names only the variable. If missing, the service reports `not_configured`. |
| `SEARCH_SUPPLIER_TIMEOUT_MS` | no | `15000` | Range 1000 to 30000. |
| `SEARCH_RATE_LIMIT` | no | `30` | Requests per window per address. Range 1 to 1000. |
| `SEARCH_RATE_WINDOW_SECONDS` | no | `60` | Range 1 to 3600. |
| `SEARCH_MAX_BODY_BYTES` | no | `16384` | Range 1024 to 65536. |
| `PORT` | set by Render | `3001` locally | |

There is no production option in the service. The Duffel adapter is started in sandbox mode only, so production cannot be enabled by configuration. Enabling production needs a code change and owner approval (signed supplier agreement, `docs/05`).

## 5. Render: manual steps (owner)

Blueprint: `deploy/render/search-service.yaml` (free plan, `autoDeploy: false`, health check `/health`, start command `node apps/search/src/main.ts` (run directly so SIGTERM reaches the service), build `npm ci`, Node 22.23.4).

1. In Render, choose **New > Blueprint** (or **New > Web Service**) from this repository. Use the blueprint file. Do not enable auto-deploy.
2. Set `SEARCH_ALLOWED_ORIGINS` to the exact https origin of the static staging site (Render shows it on that service's page). Nothing else is needed for the first start.
3. Leave `SEARCH_SUPPLIER` as `none` until a sandbox token is approved. The service then starts and reports "not connected" for every search. This is the expected staging state.
4. Only after step 3 and owner approval of the Duffel sandbox: in the Duffel dashboard create a sandbox access token, set `SEARCH_SUPPLIER` to `duffel` and paste the token into `DUFFEL_ACCESS_TOKEN` in Render's **Environment** tab, marked as secret. Do not paste it into chat, a file or a commit.
5. Open `https://<search-service>.onrender.com/health`. It should show `{"status":"ok"}`.
6. To connect the static site, set its build variable `FLIGHT_SEARCH_ENDPOINT` in `apps/web/src/config.js` to `https://<search-service>.onrender.com/api/flights/search`, then run `npm run build:web` and redeploy the static site with owner approval. The build adds only that origin to the Content-Security-Policy `connect-src`. Until then the static site makes no flight request.
7. Free instances sleep after about 15 minutes idle. The first search after a sleep is slow. The page shows "Searching flights…", then after about five seconds a waking-up message, and it waits up to 75 seconds. The 75 seconds is an estimate until staging measures the real wake-up time.

Staging configuration is separate. The service is named `go-search-staging` and points only at the staging static site. No production search service exists or is defined here; production needs its own blueprint, its own origin list and separate owner approval.

Single instance: the free plan runs one instance. Do not raise the instance count, because the rate limiter and the timeout settings are per process (section 9).

Nothing in this phase has been deployed. The owner deploys.

## 6. Duffel sandbox: what the owner needs to obtain

- A Duffel account with a sandbox access token. The Nigeria sign-up question is still open (`docs/05`); if sign-up is refused, the service stays on `none` and nothing is invented.
- Store the token only as the Render secret `DUFFEL_ACCESS_TOKEN`. Rotate it if it is ever shared.
- The Duffel adapter's request and response fields follow Duffel's public documentation as read from secondary sources. They are not yet verified against a live sandbox. The first live sandbox run is a required check before any result is shown as real.

## 7. Airport dataset: licence check

Checked on 24 Nov 2026 from the publishers' own pages. Nothing has been purchased or accepted.

| Source | Licence (from source) | Coverage notes | Fit |
|---|---|---|---|
| OurAirports (ourairports.com/data) | "All data is released to the Public Domain". Credit requested but not required. | Page does not state whether IATA codes are included. The data dictionary must be checked for the IATA field before use. | Preferred free candidate, subject to that check. |
| OpenFlights (openflights.org/data) | Open Database License. Derived works shared publicly must carry a free licence; commercial use needs a separate licence. | Includes IATA codes. The snapshot update cadence is not stated. | Not usable without owner approval: share-alike and commercial restrictions. |

Current state (24 Nov 2026 review): OurAirports is the preferred source. Verified from its own pages: the data dictionary defines `iata_code` as "The three-letter IATA code for the airport (if it has one)", so not every airport has one; the main CSV is regenerated every night; the public domain statement reads "All data is released to the Public Domain, and comes with no guarantee of accuracy or fitness for use"; attribution is requested but not required.

**Not verified:** actual IATA coverage for the airports we need, route coverage, and the accuracy of individual records. The sandbox cannot download the file, so the dataset has not been downloaded, counted or inspected. The dataset is not complete on this evidence and must not be described as complete.

**Import plan (documented, not implemented):** download the nightly CSV on a fixed schedule into a versioned file; keep the file date and checksum; keep only rows with a valid three-letter `iata_code` and a scheduled-service airport type; keep the last good copy if a download fails; review the row count and the codes for Nigerian and key international airports before switching over. Nothing has been imported. The current app still uses the 10 development fixture airports.

## 8. Frontend changes in this phase

- Multi-city is enabled: a journeys list with two to six rows (from, to, date), add and remove, per-journey inline errors and the summary. The journeys are kept in the URL as `legs=LOS-LHR-2026-12-01,LHR-DXB-2026-12-05`.
- Results show every journey of an offer: "Outbound" and "Return" for return trips, "Journey n of m" for multi-city.
- The search request posts the customer's search input to the service. The service validates it again.
- The client accepts only a usable endpoint (https, or localhost in development). A relative or other address is treated as not connected and no request is sent.
- Named unavailable reasons from the service are shown as their own states; unknown reasons become `provider_error`.
- The support section shows contact details only from `SUPPORT_EMAIL` and `SUPPORT_PHONE` in `config.js`. Both are `null`; the page says the details are not yet published.
- The browser check (Playwright, built output, 390 px and 1280 px): 22 of 22 passed. That covers the multi-city toggle, journey add and remove, errors, the hash carrying the legs, the unavailable state, no horizontal overflow and no page errors.

## 9. Limitations

- No live or sandbox results have been seen. Duffel has not been called with a real token. The results view has been tested with synthetic data only.
- Filters for departure and arrival windows, duration and stops apply to every journey of an itinerary (one-way, return or multi-city). A return is shown only if both legs pass. An airline filter matches an itinerary when that carrier flies at least one segment on any journey. Airline choices are built from every journey. Sorting by duration adds up all journeys; sorting by departure uses the first journey. Price sorting groups offers by currency, because amounts in different currencies cannot be compared.
- The rate limiter and its counts live in one process. Two instances would each allow the full limit. Behind Render's proxy the limit may be shared by all users (see section 3). Staging must run one instance.
- Duffel sandbox calls are not yet verified against a live sandbox. Do not enable live credentials.
- Staging at `go-yeqi.onrender.com` could not be reached from the build sandbox (403 from the agent proxy), so no live staging check has been run.
- The airport list is the 10-airport fixture until an owner-approved dataset is chosen.
- No FX source is connected, so no conversion happens. A fare is shown in the currency the supplier sells it in, with a note when that differs from the requested currency. A fresh snapshot for the pair would allow conversion; none is supplied by this service.
- Passengers: adults, children and infants are sent to the supplier as `adult`, `child` and `infant_without_seat`. Child pricing and infant pricing are not verified against the sandbox. The results page says infant fares are not confirmed.
- Free-plan cold starts make the first search slow.
- The error tints in `apps/web/src/styles.css` remain marked pending approval. Only the palette shades were provisionally approved.

## 10. Verification run (25 Nov 2026, Phase 18.2)

- `npm run test:unit`: 728 of 728 passing. Breakdown: core 53, flights 111 (includes 23 multi-city, 8 itinerary filters, 7 return-trip filters), payments 45, fulfilment 31, portal 40, support 61, notify 56, auth 104, http 43, search service 41 (34 service, 7 CORS regression), security 43, passport 28, web 72 (26 web, 24 flights, 22 multi-city). Each file was also run on its own; the per-file counts sum to 728.
- `npm run build:web`: passes. Browser output contains no supplier adapter code, no provider endpoint and no Duffel token. The search origin is absent because `FLIGHT_SEARCH_ENDPOINT` is `null`.
- Browser check of the built output (multi-city, 390 px and 1280 px): 22 of 22 passing.
- Start check: the real entry point started with `SEARCH_SUPPLIER=none` and no token. Health returned 200. Search returned 503 `not_configured` with no network call. The startup log held no secrets.

## 11. Decisions for the owner

- [ ] Approve deploying the search service to Render staging (free plan, sleeps when idle). Nothing is deployed yet.
- [ ] Create and approve a Duffel sandbox token, and resolve the Nigeria sign-up question (`docs/05`).
- [ ] Choose the airport dataset. Recommended: OurAirports, after its IATA field is verified. Not OpenFlights without approving its licence terms.
- [ ] Supply the published support email or phone, or keep "not published yet".
- [ ] Approve or refuse the error tints in `styles.css` (still pending).
- [ ] Decide whether to commit and push the Phase 17 and 18 work. Nothing has been committed or pushed.

## 11. Phase 18.4: corrections from the pre-deployment review

Each correction below was approved by the owner. None is deployed, committed or pushed.

- **Sandbox only.** `DUFFEL_ACCESS_TOKEN` must start with `duffel_test_`. The configuration refuses any other value at start-up, and the adapter refuses a non-test token in sandbox mode. Error messages name the variable and never show the value. Tests: `apps/search/test/search-service.test.ts` and `packages/flights/test/corrections.test.ts`.
- **Health check.** `GET /health` is exempt from the rate limit (`rateLimited: false` on that one route). Search and every other route are still counted. Test: `apps/search/test/search-service.test.ts`.
- **Currency.** A supplier amount is never relabelled. Without a fresh, matching FX snapshot the offer keeps its supplier amount and currency. A snapshot is used only if its capture time is readable and at most 24 hours old, and only for the pair it names. One offer that cannot be converted does not stop the batch. The results page labels every fare with its currency and notes when it is not the requested currency. Price sorting groups by currency. No FX provider is integrated, and no rate is invented.
- **Passenger types.** Adults, children and infants keep their counts from the search input to the supplier request (`adults`, `children`, `infants`). Children are sent as `child`. Infant pricing is not claimed as supported.
- **Airline filter.** An itinerary matches a chosen airline when that carrier flies at least one segment on any journey. The airline choices come from every journey. A return-only carrier can be chosen and keeps its trip.
- **Cold start.** The browser waits 75 seconds (`SEARCH_TIMEOUT_MS`), separately from the service's supplier timeout of 15 seconds. After about five seconds the page says the service is waking up. No fare or result is shown in its place.
- **Rate-limit table.** It holds at most 50,000 addresses. Expired windows are removed once per window, and more often while the table is large. When the table is full, a new address is refused until space is freed. Forwarded-address headers are still not read. Tests: `packages/http/test/http.test.ts` and `apps/search/test/search-service.test.ts`.
- **Duffel timer.** The abort timer runs until the body has been read. A slow body is a timeout. Test: `packages/flights/test/corrections.test.ts`.
- **Airport wording.** The help text says the list is a demonstration list and not every airport. The fixture is labelled as incomplete. No OurAirports data is imported.
- **Documentation.** `docs/22` no longer says multi-city is unsupported.

Known limits after this phase:
- The mock supplier (`packages/flights/src/adapters/mock.ts`) still uses a fixed FX table for test and fixture data. It is not reachable from the search service or the browser bundle, and it is not used for customer prices.
- Duffel's child and infant passenger behaviour and its response shape are unverified until a sandbox test runs.
- The 75-second browser timeout is an estimate until staging measures the wake-up time.
- Staging must still run as one instance, because the limiter is per process.

> Phase 18.7 replaces the four-currency limit described in sections 12 and 13. Read section 14 for the current rules.

## 12. Phase 18.5: pricing integrity

Owner decision: NGN is GO's default display and search currency. The rules below are implemented and tested.

- **Where FX snapshots come from.** Only `DuffelConfig.fxSnapshot` (packages/flights/src/adapters/duffel.ts). The search service never sets it (`buildSupplier` in apps/search/src/app.ts passes no FX source). No FX provider is connected, and no rate is stored or invented. In production today, no conversion happens.
- **Injection.** A customer cannot supply a rate. The search input is parsed strictly (unknown fields such as `fxRate`, `fxSnapshot`, `displayPrice` or `supplierPrice` are refused with 422 before any supplier call). Tests cover this.
- **Validation.** A snapshot is used only when: its `from` equals the offer's supplier currency, its `to` equals the requested display currency, its capture time is readable, its age is between 0 and 24 hours, and `convertMoney` accepts it (positive rate, matching source, supported exponent). Otherwise the offer keeps its supplier amount and currency. A reversed pair, a wrong destination, a stale or unreadable snapshot, and a zero rate are all tested.
- **Freshness.** 24 hours is a judgement, not a verified figure. It applies only if a rate source is ever approved. Rates move faster than that, so any future source should use a much shorter window, and the card should show the capture time. This is not decided.
- **Requested currency to Duffel.** The offer request does not include a currency (`buildDuffelOfferRequest`). Duffel returns offers in the currency it sells them in. Whether a sandbox account can return NGN offers is unverified, so "prefer genuine NGN" depends on the supplier's behaviour.
- **Returned currency.** An offer in a currency GO does not support is left out on its own. The other offers are kept. If every offer is unsupported, the response is refused as `invalid_response`.
- **Sorting, filters and totals.** Price sorting groups by currency, puts the requested currency first, then orders the rest by code. Amounts are compared only within one currency. A price limit applies only to offers in the named currency. "Showing n of m" counts all offers regardless of currency. Each card shows its currency symbol and, where it differs from the requested currency, a note.
- **Mock rates.** The mock adapter's fixed FX table (packages/flights/src/adapters/mock.ts) is used only by tests and fulfilment fixtures (packages/fulfilment/src/fixture-orders.ts). The search service and the browser bundle do not import it, and the build's source check refuses adapter files in the browser output.
- **Passengers.** Adults, children and infants keep their counts through the input, the supplier request and the Duffel body (`child`, `infant_without_seat`). Infants do not count toward seats. Infant pricing is not verified and is labelled as not confirmed.

Remaining limitations: no conversion source (so no converted prices), Duffel currency behaviour unverified in sandbox, and the 24-hour window is a judgement.

## 13. Phase 18.6: transparency for left-out offers and staging review

- **Nothing is dropped silently.** Each search response now carries `excluded: { invalidCurrency, currencies, invalidPrice }` (on `ok` and `empty`). The counts are shown to the customer as notices. `currencies` lists only valid three-letter codes, so supplier text cannot reach the page through it.
- **Unsupported currencies.** Offers in a currency GO cannot represent safely (GO supports NGN, USD, GBP and EUR, each with a verified two-digit exponent) are left out, with their count and codes shown. They are not converted and not relabelled. Showing them in their own currency would need a verified exponent and symbol for each currency, which is a separate owner decision.
- **Invalid prices.** An offer whose price is missing, unreadable, zero, negative or too large is left out and counted. A malformed response structure is still refused as `invalid_response`, because that is a supplier fault.
- **All offers excluded.** The answer is `status: "empty"` with the counts, and the page says no flights can be shown and why. It is not an error.
- **Mixed currencies.** When the shown offers are in more than one currency, the page says prices must be compared only within one currency. Every card shows its fare currency code.
- **Currency policy.** NGN stays the default. The requested currency sorts first, other currencies follow in code order, and price limits apply only to offers in the named currency. No FX provider is integrated, and no conversion is enabled. A converted fare is labelled with the currency it came from (dormant until a trustworthy source is approved).
- **Display checks.** Formatting was checked for NGN, USD, GBP and EUR at zero, one minor unit, 0.50, 1,234,567.89 and 999,999,999.99. All four have exponent 2. Zero prices are never shown.
- **Staging checks.** The service starts with no credentials, and search returns an honest `not_configured` state without any outbound call. A live-shaped token stops the service at start-up. No fake fares are available to a customer: the mock adapter is not imported by the service or the browser bundle, and the browser build refuses adapter files. Payments, ticketing, crypto and passport collection are switched off in the browser (disclaimer text only). The Render blueprint has one service, `go-search-staging`, with `autoDeploy: false`. The sign-in, sign-up, recovery and account routes are unchanged apart from the shared search route.

Known limits after this phase: no FX source; Duffel's NGN behaviour and its response shape are unverified until a sandbox run; unsupported-currency offers stay hidden (with a count) until an owner decision; the 24-hour snapshot window is a judgement.

## 14. Phase 18.7: any valid ISO 4217 currency

This section supersedes the four-currency statements in sections 12 and 13. Its rules on Intl data, the four unverified codes and the native currency selector are superseded by section 15.

- **Accepted codes.** Any three-letter code that the runtime's ISO 4217 data lists (`Intl.supportedValuesOf('currency')`, 162 codes in Node 22.23.4). The check is in `isCurrencyCode` (packages/core/src/money.ts). Lowercase, wrong-length and non-letter codes are refused, and so are unknown codes such as XXX.
- **Minor-unit exponents.** Read from ICU through `Intl.NumberFormat`, cached per code. Examples checked: NGN, USD, GBP, EUR, CHF and MRU 2; JPY, KRW, VND and ISK 0; KWD and BHD 3.
- **Not accepted until verified.** IQD, IRR, MGA and RWF. The runtime reports 0 decimal places for each, which we believe does not match ISO 4217 (IQD 3; IRR, MGA and RWF 2). Their minor units could not be confirmed from the sources available during this phase, so they are refused and counted as not displayable, not guessed. Remove a code from `EXPONENT_UNVERIFIED` only after its exponent is checked against the ISO table.
- **Withdrawn.** HRK is still listed by the runtime but was withdrawn, so it is refused.
- **Not in the runtime list.** Codes that ICU does not list, so GO cannot display them: CLF, UYW, VED, CHE, CHW, COU, MXV, USN, UYI, BOV, XBA, XBB, XBC, XBD, XUA, XTS, XXX and the metals and funds XAG, XAU, XPD and XPT. Most are funds, metals or test codes that do not price flights. UYW, VED and CLF may price flights and are the ones to revisit when their exponents are verified. XCG and ZWG are current codes and are accepted.
- **Formatting.** `formatMoney` builds the text from the integer amount with string operations only. The code is always shown: `NGN 450,000.00`, `USD 450.00`, `JPY 15,000`, `KWD 12.500`. There is no symbol table, and the code is never changed. Negative amounts keep their sign. The notify package uses the same function, so its output is unchanged for NGN and GBP.
- **Parsing.** `parseDecimalToMinor` accepts digits beyond the exponent only when they are zeros (`15000.00` for JPY). A non-zero digit beyond the exponent is refused, never rounded. A result above the safe integer range is refused.
- **Excluded offers.** The field `unsupportedCurrency` is renamed `invalidCurrency`. It counts offers whose currency is missing, malformed or not displayable. Its `currencies` list keeps only valid three-letter shapes, so supplier text is never echoed. `invalidPrice` counts missing, unreadable, zero, negative, non-decimal or too-large amounts. Valid offers are kept, and the all-excluded state keeps its explanation.
- **Browser counts.** The page counts offers it drops for a currency or price reason into the same counts, so nothing is dropped silently for those reasons. A response made only of malformed offers is still `invalid_response`.
- **Limitation.** A structurally malformed offer (for example a missing segment) is dropped by the page without a count. The service never sends that shape, so this is a defensive path only. Adding a count for it would be a contract change, which is an owner decision.
- **Requested currency.** `displayCurrency` accepts any valid code on the server. The web selector still offers NGN, USD, GBP and EUR. Widening the selector is an owner decision.
- **Pricing rules unchanged.** NGN is the default. No conversion is enabled, and no FX source exists. Price sorting and price limits stay within one currency. `convertMoney` refuses a conversion between currencies with different exponents rather than moving the decimal point. That path is reached only with an approved FX snapshot, so production does not reach it.
- **Browser dependency.** The browser build depends on the browser's own ISO data (`Intl.supportedValuesOf`). A code the service accepts may be unknown to an older browser. The page then counts that offer as invalidCurrency rather than showing it.

Remaining limitations: the four unverified exponents and the missing codes above; the Duffel sandbox has not been run with non-NGN offers; the request selector is still limited to four currencies.

## 15. Phase 18.7 correction pass: shared metadata, malformed offers, selector

**Superseded by section 16.** The currency table was provisional at the time of section 15. The official source is ISO 4217 List One from the SIX Group Maintenance Agency (https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml). On 2026-11-25 the build session could not retrieve it: the egress proxy refused the SIX host, the file is not on the session allowlist, and the ISO public page does not carry the table. Every entry must be checked against List One before the table is treated as authoritative. Until then, `CURRENCY_METADATA_VERSION` starts with `provisional-`.

- **Source of truth.** `packages/core/src/currency-metadata.ts`. Server and browser both read this one file (the browser through the vendored copy). Neither reads runtime Intl data at run time, so the two sides cannot disagree because of ICU versions.
- **Entries.** 160 entries. Each has a code, an exponent, a status (`current` or `withdrawn`) and a provenance. Provenance is `icu-snapshot` (taken from Node 22.23.4 Intl) or `owner-decision-2026-11-25`.
- **Owner-decided minor units.** IQD 3, IRR 2, MGA 2, RWF 0. These four are current and displayable.
- **HRK.** Withdrawn. New amounts and new supplier offers refuse it. Stored records stay readable: `historicalMoney()` and `formatMoney()` accept it, so a historical amount shows as `HRK 1.00`.
- **UYW, VED, CLF.** Not listed, so not displayable. They could not be checked against List One. UYW and CLF are unit-of-account or fund-style codes, which do not price flights. VED may be a current currency but is unverified. Add an entry only after List One confirms it is current and appropriate for flight prices.
- **Not listed on purpose.** Funds, precious-metal and unit-of-account codes. XDR (special drawing rights) and XSU (sucre) were in the runtime snapshot and were removed for this reason.
- **Rules.** `isCurrencyCode` means current and listed (used for new amounts). `isKnownCurrencyCode` means listed in any status (used for stored records). `minorUnitExponent` throws for an unlisted code.
- **Malformed offers.** An offer that is structurally unreadable (not an object, missing id, missing or unreadable expiry, no journeys, a journey count that does not match the request, or an unreadable segment) is skipped and counted as `excluded.malformed`. The valid offers are kept. The response is refused as `invalid_response` only when the offers list is missing altogether. The browser does the same and counts its own drops under `malformed`, so the service and browser contract is the same: `{ invalidCurrency, currencies, invalidPrice, malformed }`.
- **Currency selector removed.** The search form no longer offers a currency choice, and every search asks for NGN. GO does not convert prices, so a selector would have implied a conversion that does not exist. Each result card shows the fare in the currency the airline sells it in, and the results page states this in a notice.
- **Service message.** The `fx_unavailable` text no longer mentions choosing a currency.
- **Exactness.** Amounts remain integer minor units. Parsing refuses non-zero digits beyond the exponent and never rounds. Formatting uses string operations only.

Remaining limitations: the table is not yet verified against List One (the main gate); the Duffel sandbox has not been run with non-NGN offers; a fare that is shown in a foreign currency is not converted, and no FX source exists.

## 16. Phase 18.7: currency table verified against SIX List One

This section supersedes the provisional and verification-gate wording of section 15.

- **Source.** ISO 4217 List One, SIX Group Maintenance Agency, publication date 2026-09-17. The owner supplied the file on 2026-11-26, and it is committed as `packages/core/data/iso-4217-list-one-2026-09-17.xml` (SHA-256 `33139b438657d1cee116ba737807ea71d19d6de4b90f799a09c56f0cc6a1b0ff`). Version `six-list-one-2026-09-17`.
- **Generation.** `scripts/generate-currency-metadata.mjs` writes `packages/core/src/currency-metadata.ts` from that XML. The output is deterministic, and the file must not be edited by hand. A test checks every official entry against the XML.
- **Contents.** 184 entries: 155 current ordinary currencies, 6 legacy currencies, 10 funds (flagged `IsFund="true"` in the XML), and 13 special-purpose codes (minor unit N.A.).
- **Corrections applied.** The 13 currencies that the runtime snapshot gave 0 decimal places now have 2: AFN, ALL, COP, HUF, IDR, KPW, LAK, LBP, MMK, PKR, SOS, SYP, YER. The owner-decided IQD 3, IRR 2, MGA 2 and RWF 0 match the XML.
- **VED added.** VED is an ordinary current currency, 2 minor units, official number 926. VES (928) is also current. The two are separate codes. Nothing in the code maps one to the other, and each formats with its own code.
- **Legacy codes.** ANG, BGN, CUC, SLL, ZWL and HRK are not in List One. They are marked `listStatus: 'legacy'`, not withdrawn. Their historical status and minor units are not verified against any historical list, so their provenance reads `legacy-not-in-list-one-unverified`. They are refused for new amounts and new supplier offers, and they still format for stored records. SLL's 0 decimal places comes from the runtime snapshot and is unverified.
- **Funds and special codes.** Kept in the table with their official classification, so the classification is preserved. They are refused for all amounts. UYW and CLF are funds, so they stay excluded.
- **Rules.** `isCurrencyCode` requires an ordinary current currency. `isKnownCurrencyCode` requires an ordinary currency in any status. `minorUnitExponent` throws for anything that is not an ordinary currency.

**Still open.** The historical status and minor units of the six legacy codes, including HRK's exponent of 2, must be verified against ISO's historical list before those entries are described as authoritative. That list was not supplied, and absence from List One is not evidence that a code never existed.

