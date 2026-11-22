# 21. Frontend build, browser checks and email options (Phase 15 follow-up)

Date: 22 Nov 2026
Status: frontend built with no dependencies and checked in a headless browser. The build blocker is
documented below and has NOT been bypassed. The email comparison is research only. Nothing was activated,
purchased or signed up for. Nothing committed or pushed.

## 1. The build blocker (documented, not bypassed)

| Check | Result (22 Nov 2026) |
|---|---|
| npm registry (`registry.npmjs.org`) | Not reachable: DNS cannot resolve the host, so no package can be installed |
| Supabase project host (`gghsvzighgqqamibjywu.supabase.co`) | Refused by the sandbox proxy (CONNECT 403). The live auth settings could not be read |
| Browser tooling | Chromium and Playwright are preinstalled and work |
| TypeScript compiler | `tsc` 7.0.2 is installed globally and type-checks the auth modules |

Effect: no frontend framework (React, Next.js, Vite) can be installed, and no package-based test or build
tool can be added. The network restriction is not a bug in GO, and it has not been worked around.

Chosen approach, which keeps the security architecture: a dependency-free static app. Plain ES modules,
`fetch` to Supabase Auth over HTTPS, a build script (`scripts/build-web.mjs`) that refuses to finish if the
output breaks a security rule. `npm run build:web` is the production build for this app.

Owner options to unblock a framework later (your decision):
1. Allow the npm registry in the build environment, then add a framework with pinned versions and `npm ci`.
2. Keep the dependency-free build, which is adequate for the current screens.

## 2. Frontend status

Location: `apps/web/src` (source), `apps/web/dist` (build output, git-ignored).

Built:
- Start page, customer sign-up (with client checks matching the server rules), sign-in, sign-out.
- Email confirmation notice, password recovery request (same message whether or not the account exists).
- Recovery callback: a fragment with a recovery token opens the new-password form (in memory only).
- Two-step sign-in challenge (for accounts with a verified factor).
- Two-step sign-in setup (TOTP enrolment and confirmation) on the security page.
- Staff page: refused for customers, and refused for staff without an MFA session. It shows no data yet.
- Content Security Policy: `default-src 'none'`, scripts and styles from the same origin only, connections to
  Supabase only, no inline scripts, no `unsafe-eval`, `object-src 'none'`.
- Text is set with `textContent` only. The build refuses `innerHTML`, `insertAdjacentHTML`, `document.write`
  and `eval`.
- Sessions live in memory only. A reload signs the person out (safer until a server-side session exists).
- The browser holds only the project URL and the publishable key. The build refuses any secret or service
  key pattern in any source file, and the client refuses a non-publishable key at runtime.

Checks (evidence):
- Unit tests, including `apps/web/test/web.test.js`: 26 pass. They cover route decisions, parity of the
  password rules with `packages/auth` (same results for six cases), public message parity, no request
  carrying a bearer token for anonymous calls, no response body shown to a person, generic network
  failures, in-memory sessions, and the build checks (including refusal of an inline script, an event
  handler, `innerHTML`, and a secret key).
- Headless Chromium (desktop 1280 px and phone 390 px): the start, sign-in and sign-up pages render with
  their headings, no horizontal scrolling, and no console errors after the CSP fix.
- Build: `npm run build:web` writes 7 files with no problems.

Not done, and must be verified before any reliance:
- The Supabase Auth endpoint paths (signup, token, recover, user, factors, challenge, verify) follow
  Supabase's HTTP API as supabase-js uses it. They have NOT been called against the live project, because
  the sandbox proxy refuses that host. Verify them with a test account on the dev project.
- Dashboard redirect URLs. Recovery links need the GO origin listed in Supabase's redirect allow-list (manual).
- Frame protection: `frame-ancestors 'none'` must be sent as an HTTP header by the host, because browsers
  ignore it in a meta tag. Hosting configuration is not built yet.
- Staff screens, customer booking pages, accessibility review with a screen reader, and translation.
- Session refresh while the page stays open (the access token expires after one hour).

## 3. Supabase's default email service (for development and testing)

Verified on the Supabase documentation pages (read 22 Nov 2026):
- The default SMTP service "is not meant for production use", is best effort with no SLA, and "will refuse to
  deliver messages to addresses that are not part of the project's team".
- Its limit is 2 messages per hour per project, and the documentation warns the limit "can change without
  notice".
- Custom SMTP lifts the default to 30 messages per hour, which can be raised on the Rate Limits page.

Consequence for GO: during development, emails will reach only project team members, at 2 per hour. Testing
the customer sign-up or recovery flow with other addresses will not work. Staff MFA reset notices cannot reach
staff who are not team members on this default service. This is a real blocker for staff notification.

## 4. Free email options (research only; nothing signed up for)

Sources read on 22 Nov 2026:
- Resend: [pricing](https://resend.com/pricing.md)
- Brevo: [free plan limits](https://help.brevo.com/hc/en-us/articles/208580669)
- Amazon SES: [pricing](https://aws.amazon.com/ses/pricing/)
- Postmark: [pricing](https://postmarkapp.com/pricing.txt)
- Supabase: [auth SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [rate limits](https://supabase.com/docs/guides/auth/rate-limits)

| Option | Free terms (as read) | Paid step | Nigeria sign-up | Security and data location | Fit for GO |
|---|---|---|---|---|---|
| Supabase default | 2 per hour, team members only, not for production | none | not applicable | Supabase-operated, best effort | Development only |
| Resend | 3,000 per month, 100 per day, 3 custom domains (page does not state whether a domain is required) | Pro from $20 per month for 50,000 | NOT VERIFIED | NOT VERIFIED (DPA, sub-processors, region) | Best free monthly volume among those read. The 100 per day cap is tight for launch |
| Brevo | 300 per day, resets daily. Free emails carry "Sent with Brevo" branding. SMTP access not confirmed on this page | Starter with branding removal | NOT VERIFIED | NOT VERIFIED | Daily cap and branding make it weaker for customer-facing mail |
| Postmark | 100 per month, no expiry, no overage allowed | Basic $15 per month for 10,000 | NOT VERIFIED | NOT VERIFIED | Lowest free volume; reliable for transactional mail at low volume |
| Amazon SES | The fetched page describes general AWS credits (up to $200, free plan for 6 months, use within 12 months). No permanent SES free tier was found | pay-as-you-go after credits | NOT VERIFIED | NOT VERIFIED | Not a permanent free option; needs an AWS account and card, which needs your decision |

Recommendation (for your decision; nothing activated):
1. Keep Supabase's default for development, with team-member test addresses only.
2. For a pilot before launch, Resend's free tier has the highest free monthly volume of the options read,
   with a 100 per day cap. It is the candidate to check first, but only after three things are verified:
   (a) GO can create an account from Nigeria (the Duffel sign-up gave a country-list problem, so do not
   assume it), (b) a data processing agreement and sub-processor list are available, and (c) counsel has
   reviewed the transfer of personal data outside Nigeria under the NDPA.
3. Postmark is the fallback if deliverability is more important than volume at low cost.
4. Do not choose SES without a decision on an AWS account and card.

No option has been activated, and none has a paid step that GO would enter without your approval.

## 5. Open items

- Verify Supabase Auth endpoints and dashboard settings against the live dev project (needs a network path
  the sandbox does not have, or your manual check).
- Decide the email provider. Until then, staff MFA reset notices cannot be delivered to staff outside the
  team.
- Choose the frontend build path (section 1).
