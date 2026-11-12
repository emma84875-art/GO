# Email and monitoring: recommendations for approval

Status: **Recommendations only. No account created, no subscription bought, no paid service activated, no data processing agreement signed.** The owner approves each item before anything is set up.

Selection criteria, in the owner's priority order: reliability, reasonable cost, security, ease of integration.

## How to read the figures

- Prices and free-tier limits come from a **secondary source** (MakerKit's 2026 comparison, checked against provider pricing pages on 6 November 2026, per that article). The vendor pricing pages were not reachable from this environment, so **every figure must be re-checked on the vendor's own page before approval.**
- Sentry figures come from a second secondary source dated 8 November 2026.
- "Not verified" means we have not confirmed it from the vendor's own documentation.
- Currency is USD. Naira billing, VAT and tax treatment are not checked.

---

## 1. Transactional email

Booking confirmations, ticket delivery, schedule-change notices and refund notices are the most important messages the platform sends. A missed ticket email is a customer-trust failure, so deliverability is ranked above price.

### Options compared

| | **Postmark** (recommended primary) | **Resend** (recommended alternative) | **Amazon SES** (cost option at scale) |
|---|---|---|---|
| Free tier | 100 emails/month | 3,000 emails/month, 100 per day | None for new accounts (ended 21 July 2026) |
| Paid, 10,000/month | $15 | $20 | about $1 |
| Paid, 50,000/month | $55 | $20 | about $5 |
| Paid, 100,000/month | $115 | $35 | about $10 |
| Overage | $1.80 per extra 1,000 (Basic) | $0.90 per 1,000 (pay as you go) | $0.10 per 1,000 |
| Message history | 45 days default; up to 365 on higher plans | 30 days on self-serve plans | Via AWS services |
| Separate transactional and marketing streams | Yes (separate infrastructure) | Not stated | Yes, by configuration |
| Batch sending | Up to 500 messages per call | Up to 100 per batch | Via API |
| Dedicated IP | Not stated | Only on top plan | Available, extra cost |
| Sending restrictions on new accounts | Approval needed before sending outside verified domains | Not stated | Starts in sandbox: 200 messages per 24 hours, until approved |
| Event notifications | Webhooks | Webhooks | Through AWS (SNS, EventBridge, CloudWatch, Firehose), not webhooks |
| Integration with Next.js | Official SDK; HTTP API | React Email support, HTTP API, SDK | HTTP API and AWS SDK |

### Security and data handling (what we know and what we must check)

| Item | Status |
|---|---|
| TLS for sending and API | Standard for all three; to confirm in each provider's security documentation |
| Data residency (where message content and logs are stored) | **Not verified for any provider.** The secondary source did not cover it. Must be confirmed before use. |
| Data processing agreement | Required before sending personal data. Not yet offered or reviewed. |
| Deliverability (inbox placement) | **No independent test data.** The secondary source did not run inbox-placement tests. We need a trial on a test domain before deciding. |
| Bounce and complaint handling | SES: AWS reviews accounts with bounce rate of 5% or complaint rate of 0.1%. Postmark and Resend: to confirm. |
| Authentication setup | SPF, DKIM and DMARC records on our sending domain, required by all three |

### Recommendation

**Postmark** for booking-critical messages. Its separate transactional stream, long history of transactional mail, and approval step for new senders suit the risk profile. It costs more than Resend at 50,000 messages a month ($55 against $20).

**Resend** is the alternative if cost and developer speed matter more. It has a generous free tier and cheap paid plans, but its dedicated IP option is on the top plan only.

**Amazon SES** is the cost option once volume is high. It needs more integration work and the event pipeline is through AWS.

**Trial needed before choosing:** a 2-week trial on a test subdomain, sending to several inbox providers, measuring placement, delivery time and bounce handling.

### Integration requirements (any provider)

- DNS: SPF, DKIM and DMARC on the sending domain.
- Webhook or event handling with signature verification, and idempotency on event IDs.
- Templates reviewed by counsel before launch (see `10`).
- Personal data minimised in message content. Card numbers and passport numbers never appear in emails.

---

## 2. Error and performance monitoring

### Recommendation: Sentry

Sentry is the standard tool for application errors. It supports Next.js and TypeScript, source maps, release tracking, and alerting.

| Item | Status |
|---|---|
| Developer plan | **Free**: 5,000 errors per month (secondary source, 8 Nov 2026) |
| Team and Business plans | **Prices not stated** in the secondary source. Must be checked on sentry.io/pricing |
| Performance, replays, attachments | Metered separately; monthly figures not stated |
| Data residency | **Not verified.** Must be confirmed before production error data is sent |
| Data processing agreement | Required. Not offered or reviewed |
| Security | Data scrubbing rules needed: no personal data, card data or passport numbers in events |

### Before connecting Sentry to any environment

- Data scrubbing configured and tested with synthetic personal data.
- Session replay disabled for booking and payment pages.
- Development and staging projects kept separate from production.
- DPA and data-residency answers recorded in `docs/01`.

---

## 3. Other monitoring: not yet recommended

These are needed before launch, and I have not researched them, so I am not recommending a specific product:

- **Uptime and public status page**: external checks on the public site and booking API.
- **Job queue monitoring**: pg-boss job state (failed, stuck, retried). Planned as part of the admin dashboard, so it needs no extra vendor.
- **Log aggregation**: Vercel and Supabase logs are the starting point for the pilot.

I can research uptime and log tools if you want them included.

---

## 4. Summary for approval

| Item | Recommendation | Free tier | Lowest paid tier (secondary source) | Approval needed |
|---|---|---|---|---|
| Transactional email | Postmark (alternative: Resend) | Postmark 100/month; Resend 3,000/month | Postmark $15 (10k); Resend $20 (10k or 50k) | Yes |
| Error monitoring | Sentry | 5,000 errors/month | Team and Business prices not stated | Yes |
| Uptime and logs | Not yet recommended | Unknown | Unknown | Research first |

**Nothing has been purchased, created or activated.** Each item needs your written approval, plus a data processing agreement and data-residency confirmation, before setup.
