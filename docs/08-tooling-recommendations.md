# Email and monitoring recommendations

Status: **Recommendations only. Nothing is purchased, signed up for, or activated.** Approval is needed before any paid service or data-processing agreement.

Selection criteria, in your priority order: reliability, reasonable cost, security, ease of integration.

Pricing below comes from secondary sources, not vendor pricing pages (those were not reachable from this environment). Every figure must be checked on the vendor's own page before you decide. Prices are USD.

## 1. Transactional email

Booking confirmations, ticket delivery and refund notices are the most important messages the platform sends. Missing one is a customer-trust failure, so deliverability matters more than price.

| Option | Price point (secondary source, 6 Nov 2026) | Strengths | Concerns |
|---|---|---|---|
| **Postmark** (recommended primary) | $55/month for 50,000 emails; $15 for 10,000 | Transactional and broadcast streams run on separate infrastructure. Strong reputation for transactional mail. Batch API. 45-day message history by default, up to 365 on higher plans. | Higher cost per volume. New accounts need approval before sending outside verified domains. |
| **Resend** (recommended alternative) | $20/month for 50,000 emails; $20 for 10,000 | Good developer experience, React Email support, idempotency keys. Lower cost at this volume. | Dedicated IPs only on its top plan. 30-day history on self-serve plans. |
| **Amazon SES** (cost fallback at scale) | $0.10 per 1,000 emails, pay as you go; about $5 for 50,000 | Lowest cost at scale. Strong infrastructure. | Free tier for new accounts ended 21 July 2026. Starts in a sandbox (200 messages per 24 hours) until approved. Events arrive through AWS services, not webhooks, so more integration work. |

**Our recommendation:** Postmark for booking-critical messages, because deliverability is the priority and the cost difference is small relative to a single missed ticket email. Resend is a sound alternative if you prefer lower cost and faster integration. Move to Amazon SES only if volume grows enough to make per-email cost the main concern.

**Before we commit to any provider, we must:**
- Confirm where the provider stores message content and logs, and whether that is acceptable under the Nigeria Data Protection Act. Secondary sources did not cover data residency for any of these providers.
- Sign the provider's data-processing agreement.
- Set up SPF, DKIM and DMARC for our sending domain.
- Run a trial on a test domain and send to several inbox providers to check placement. We have no independent deliverability test data.

## 2. Error and performance monitoring

**Recommendation: Sentry.** It is the standard tool for application errors, with source maps, release tracking, and integration with Next.js and Supabase-based code.

- **Developer plan:** free, including 5,000 errors per month (secondary source, 8 Nov 2026). Good enough for development and a limited pilot.
- **Team and Business plans:** prices are not stated in the secondary source. Check sentry.io/pricing before deciding. Performance monitoring, session replay and attachments are metered separately.
- **Data residency:** not covered by the secondary source. Confirm whether data can be kept in a specific region before we send any production error data, because errors can contain personal data.

**Use with care:** Sentry events must be scrubbed of personal data, card data and passport numbers before they leave our servers. We set this up before connecting Sentry to production.

## 3. Other monitoring

These are needed for launch, but I have **not researched** them yet, so I am not recommending a specific product:

- **Uptime and status page:** an external check that tells us when the public site or booking API is down.
- **Job queue monitoring:** pg-boss jobs (ticketing, reconciliation, notifications) need an admin view of failed and stuck jobs. This can be built in the admin dashboard, which avoids another vendor.
- **Log aggregation:** starting with Vercel and Supabase logs is reasonable for the pilot. Dedicated log tooling can come later.

I can research and compare uptime and log tools next, if you want them in this plan.

## 4. Summary and approvals needed

| Item | Recommended | Cost to approve | Approval needed |
|---|---|---|---|
| Transactional email | Postmark (alternative: Resend) | $15–$55/month depending on volume (secondary source) | Yes |
| Error monitoring | Sentry, Developer plan first | Free to start; paid tiers not confirmed | Yes |
| Uptime and logs | Not yet recommended | Unknown | Research first |

No purchases, signups or data-processing agreements have been made.
