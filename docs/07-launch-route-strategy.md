# Launch route strategy

Status: **Proposal for owner decision.** Based on the sources below, fetched 2026-11-12. The route catalogue is data, not code: the architecture does not restrict launch to these routes. Adding a route is a configuration change, subject to the supplier confirming coverage.

## What the data shows

### Domestic demand

- **National domestic passengers, 2025:** 13.09 million, against about 12.54 million in 2024. Domestic was 72.96% of total air traffic in 2025. Source: FAAN figures reported by [Nairametrics](https://nairametrics.com/2026/06/07/nigerias-domestic-air-passenger-traffic-hits-13-09-million-in-2025-faan/).
- **Lagos–Abuja** is described as the busiest domestic corridor from Terminal 2 at Murtala Muhammed Airport. Asaba and Port Harcourt also rank among its busiest routes. Terminal 2 averages 60 to 65 daily departures. The article gives **no route passenger counts**, so these are rankings, not volumes.
- **Abuja Airport, 2024:** 5.48 million passengers in total. Daily averages of 12,155 domestic and 2,871 international passengers imply roughly 4.4 million domestic and 1.0 million international a year (our calculation). Source: [Nairametrics](https://nairametrics.com/2025/09/24/abuja-airport-records-5-48-million-passengers-in-2024-port-harcourt-handles-1-19-million/).
- **Port Harcourt Airport, 2024:** 1.19 million passengers, of which 1.08 million domestic and 111,846 international. Same source.
- **Fares:** ticketing agents reported many domestic routes at N120,000 to N150,000 for most of 2025, with some above N200,000 in December. An NBS figure of N89,975.68 average fare is from January 2024. Source: the FAAN article above.

### International demand

Two sources, from different periods, are combined below.

**A. Passengers departing Nigeria by air, IATA origin-destination data, 2023** ([Nairametrics, Oct 2025](https://nairametrics.com/2025/10/19/iata-data-reveals-top-10-international-destinations-nigerians-are-flying-to/4/)):

| Rank | Destination | Passengers | Share of outbound |
|---|---|---|---|
| 1 | London | 421,300 | 20.3% |
| 2 | Accra | 122,300 | 5.9% |
| 3 | Jeddah | 92,100 | 4.4% |
| 4 | Toronto | 60,300 | 2.9% |
| 5 | Manchester | 59,800 | 2.9% |
| 6 | New York | 47,200 | 2.3% |
| 7 | Madinah | 45,500 | 2.2% |
| 8 | Johannesburg | 45,200 | 2.2% |
| 9 | Washington, D.C. | 43,000 | 2.1% |
| 10 | Cairo | 37,400 | 1.8% |

**B. Scheduled nonstop flights from our two airports, FlightRadar24 data, August 2025** (per the [EUAA Nigeria country focus](https://www.euaa.europa.eu/nigeria-country-focus/391-international-flights)):

- **Lagos (LOS), nonstop:** Abidjan, Accra, Addis Ababa, Amsterdam, Atlanta, Banjul, Beirut, Cairo, Casablanca, Doha, Dubai, Frankfurt, Istanbul, Johannesburg, Kigali, Lomé, London (Air Peace and British Airways), Luanda, Malabo, Nairobi, Paris, Santiago de Chile, São Paulo, Washington (United).
- **Abuja (ABV), nonstop:** Algiers, Accra, Casablanca, Addis Ababa, Maasai Mara, Abidjan, Douala, Doha, Frankfurt, Niamey, Lomé, Paris, Istanbul, N'Djamena, London (British Airways).

Destinations from the IATA top ten that have **no nonstop listed** from Lagos or Abuja in this snapshot: Toronto, Manchester, New York, Jeddah, Madinah. These need connecting itineraries or a route-specific check.

## Caveats

- The IATA data is from 2023, and the schedule snapshot is from August 2025. Both are older than the launch date.
- Neither source is booking data. A nonstop flight being scheduled does not mean the flight is bookable through our supplier.
- Route counts for Nigerian domestic routes are not published. Lagos–Abuja's lead is a ranking, not a volume.
- **We do not yet know which Nigerian domestic airlines and international carriers are available through Duffel.** This could block domestic routes entirely, so supplier coverage must be confirmed before any route is announced.
- Commercial route-level data (schedules, seat capacity, booking demand) is available from OAG or Cirium. Their licences cost money, so we need your approval before buying. Recommended for the decision, not required for the architecture.

## Recommended launch waves

Each route needs supplier confirmation of search, pricing and ticketing before it goes live.

### Wave 1: launch

**Domestic**
1. **Lagos–Abuja (LOS–ABV):** the busiest domestic corridor reported from Terminal 2 in Lagos. The corridor's lead is a ranking, not a published volume.
2. **Lagos–Port Harcourt (LOS–PHC):** Port Harcourt handled 1.19 million passengers in 2024, mostly domestic (1.08 million). It is third of the three airports with published 2024 figures, after Lagos and Abuja.
3. **Lagos–Asaba (LOS–ABB):** named among the busiest routes from Terminal 2. Included only if supplier coverage is confirmed.

**International from Lagos** (nonstop in the 2025 snapshot and top-tier demand in the 2023 data):
4. **Lagos–London (LOS–LHR):** largest single outbound market (421,300 passengers in 2023). Nonstop from both LOS and ABV.
5. **Lagos–Accra (LOS–ACC):** second-largest outbound destination; short-haul, a strong test route for the product.
6. **Lagos–Johannesburg (LOS–JNB):** eighth-largest outbound destination; nonstop.
7. **Lagos–Dubai (LOS–DXB):** a major hub connection to Asia and the Middle East (no ranking in the top ten; included for hub demand, not demand-ranked).
8. **Lagos–Washington (LOS–IAD):** ninth-largest outbound destination and nonstop with United. Strong fit for the premium positioning.

**International from Abuja** (nonstop, and the best fit for ABV's own catchment):
9. **Abuja–London (ABV–LHR):** nonstop with British Airways. London is the largest outbound destination nationally, so this route serves the Abuja catchment directly.
10. **Abuja–Paris and Abuja–Frankfurt:** nonstop, European business demand.

### Wave 2: after Wave 1 is stable

- **Lagos–Toronto, Lagos–Manchester, Lagos–New York, Lagos–Jeddah/Madinah** (high demand, no nonstop in the snapshot). Launch only with confirmed supplier availability. Connecting routes are acceptable where they meet the product standard.
- **Port Harcourt, Kano, Enugu** as origins, once domestic and international supplier coverage is confirmed. Kano and Enugu appear in the EUAA list but we have no demand figures for them.
- **Lagos–Cairo, Lagos–Istanbul, Lagos–Doha** as hub connections.

### Wave 3: international expansion

Architecture supports any origin-destination pair with a supplier connection. Expansion beyond Nigeria (for example, Accra or Johannesburg as origins) follows the same process, and is not started until Nigerian operations are stable.

## What we must do before announcing any route

1. Confirm the supplier returns offers for the route, with segment times in the correct time zones.
2. Confirm ticketing for the route under the authority we agree (see the payment and fulfilment policy).
3. Confirm the fare rules and refund terms for each carrier.
4. Confirm passenger document requirements for destination countries (visas and passport validity are not checked by us, but customers must be told).
5. Legal review of the route-specific terms.

## Decision needed

Confirm Wave 1 scope (ten routes above, or a smaller set), and whether you want to fund an OAG or Cirium data licence to replace the public snapshots with current schedules before launch.

## Update 12 Nov 2026: domestic evidence, hub emphasis, and data evaluation

### Domestic evidence

- **Lagos–Abuja** is the busiest domestic route. Asaba and Port Harcourt are named among the next busiest. Source: an interview with the Acting COO of Bi-Courtney Aviation Services (MMA2), published by [Nairametrics, 1 March 2026](https://nairametrics.com/2026/03/01/mma2-lagos-abuja-asaba-port-harcourt-busiest-domestic-routes-bi-courtney-coo/). This is an operator's ranking based on undisclosed operational data for an undisclosed period. No route passenger counts were published.
- Terminal 2 at Lagos averages 60 to 65 departures a day, and sometimes runs five flights on one route in a day. Source: same article.
- Domestic fares reported by ticketing agents: N120,000 to N150,000 for most of 2025, and above N200,000 in the December peak. Source: the [FAAN 2025 report, Nairametrics](https://nairametrics.com/2026/06/07/nigerias-domestic-air-passenger-traffic-hits-13-09-million-in-2025-faan/). These are agent-reported, not published fare data.
- Scheduled domestic seat capacity was reported at 1.22 million in August 2026 ([Nairametrics, 5 Aug 2026](https://nairametrics.com/2026/08/05/nigerias-scheduled-airline-seat-capacity-rises-37-to-1-22-million-in-august/)). The headline is the only figure we have seen, so it is noted but not used to rank routes.

**Domestic Wave 1 remains:** Lagos–Abuja, Lagos–Port Harcourt, Lagos–Asaba. **Abuja-origin domestic routes are not yet evidenced.** Abuja handled about 12,155 domestic passengers a day in 2024, but no route-level data supports choosing which Abuja domestic routes to launch first. This is a gap to close with supplier data.

### Abuja as an international hub

Abuja is a full international departure point in this data, and it is the stronger origin for European and North African routes:
- Nonstop from Abuja in the August 2025 snapshot: London (British Airways), Paris, Frankfurt, Istanbul, Doha, Accra, Addis Ababa, Casablanca, Algiers, Lomé, Abidjan, Douala, Niamey, N'Djamena, Maasai Mara.
- Abuja handled about 1.0 million international passengers in 2024 (our calculation from daily averages).

Wave 1 international proposal:
- **From Lagos:** London, Accra, Johannesburg, Dubai, Washington.
- **From Abuja:** London, Paris, Frankfurt, Istanbul, Doha.

London from both airports is deliberate: it is the largest outbound market, and offering it from both hubs lets us test which airport customers prefer.

### What the supplier data can tell us (evaluation plan, before any licence is bought)

Our supplier connections are the cheapest source of current, bookable data. The evaluation runs first, and a paid data licence is considered only if it fails to answer the questions below.

**Questions the supplier data must answer for each candidate route:**
1. Does the supplier return offers at all for this route, and for which airlines?
2. How many distinct flights and departures per week does it return for a sample period?
3. What is the typical price spread across cabins and days of the week?
4. What share of offers can be held, and what share allow instant payment only?
5. How often do offers change between search and quote?

**Test window:** these questions are answered in the Duffel sandbox once access is confirmed. Until then, no route is ranked on supplier evidence.

**Data licence decision:** not purchased. The owner has asked that OAG or Cirium is considered only if the supplier evaluation leaves gaps that matter for launch. We would then need a licence quote and a written justification comparing its cost with the revenue at stake on those routes.

### Commercial viability

Route economics cannot be assessed yet. We have no published international fare data for these routes, no supplier pricing, and no cost of ticketing per route. Commercial viability is assessed per route when supplier pricing is available, using: average selling price, supplier cost (including the $3 per order and 1% managed content fee quoted for Duffel's pay-as-you-go tier, to be confirmed), payment and FX costs, and expected volume.

### Revised decision

Confirm Wave 1 as:
- **Domestic:** Lagos–Abuja, Lagos–Port Harcourt, Lagos–Asaba (subject to supplier coverage).
- **International from Lagos:** London, Accra, Johannesburg, Dubai, Washington (subject to supplier coverage).
- **International from Abuja:** London, Paris, Frankfurt, Istanbul, Doha (subject to supplier coverage).

No route goes live until supplier search, pricing and ticketing are confirmed in writing and tested.
