# 20. Authentication and account security (Phase 15)

Date: 22 Nov 2026
Status: access rules, database enforcement and server-side checks built and tested. The Supabase
dashboard settings in section 4 are NOT configured and need your action. There is no frontend, so
no protected pages exist yet. GO is not production-ready. Nothing committed or pushed.

## 1. What was built

| Area | Where | Evidence |
|---|---|---|
| Operations role (new) | `supabase/migrations/20261122000000_auth_roles_and_mfa.sql`, `packages/auth/src/actor.ts`, `token.ts` | RLS checks 20-21; unit tests |
| Staff role needs a verified MFA method | same migration, trigger `profiles_require_mfa_for_staff` | RLS check 20a |
| Role changes need an admin in an MFA session | same migration, `guard_profile_role()` | RLS checks 22a-22d |
| Passenger details: support and admin only | same migration, `staff_passenger_details()` | RLS check 21d |
| Permission matrix, deny by default | `packages/auth/src/access.ts` | `access-control.test.ts` |
| Request authentication (token, DB role, MFA enrolment) | `packages/auth/src/session.ts` | `access-control.test.ts` |
| Login throttling (per address and per account) | `packages/auth/src/account-security.ts` | `account-security.test.ts` |
| Password rules checked before sending | `account-security.ts` (`passwordIssues`) | `account-security.test.ts` |
| Fixed public messages (no account or token detail) | `account-security.ts` (`publicMessageFor`) | `account-security.test.ts` |
| Test-only `auth.mfa_factors` stand-in | `supabase/tests/00_supabase_shim.sql` | `scripts/test-db.sh` |

Migrations applied to the dev project `go-dev-free` (free tier): `auth_roles_and_mfa` and
`trigger_privileges` (revokes API execution of the new trigger function, found by the advisor).

## 2. Role matrix

| Permission | Customer | Support | Operations | Admin |
|---|---|---|---|---|
| Read own bookings | yes | - | - | - |
| Read all bookings, payments, tickets (MFA) | - | yes | yes | yes |
| Read passenger details of an assigned booking (MFA, logged) | - | yes | **no** | yes |
| Cancel with supplier (MFA) | - | yes | **no** | yes |
| Issue refund (MFA) | - | - | - | yes |
| Manage assignments (service path) | - | - | - | yes |
| Read audit log (MFA) | - | - | - | yes |
| Change a user's role (MFA, logged server path) | - | - | - | yes |

Staff need a verified MFA method before a role is granted, and every staff action needs an aal2
session. Customer MFA stays optional, as you approved.

## 3. Enforcement layers

1. **Supabase Auth** verifies the token and sets `aal`.
2. **Database (RLS and functions)** decides what data a role can see. Role changes are limited to an
   admin in an MFA session or the service role, and a staff role is refused without a verified factor.
3. **Server (`packages/auth`)** verifies the token, reads the role from the database (never from token
   claims), refuses staff without MFA enrolment, and denies any permission not in the matrix.
4. **Frontend**: not built. Route protection will be added with the frontend and must call the server
   checks. Frontend-only protection is not accepted.

## 4. Supabase dashboard configuration (MANUAL, not done)

I have no dashboard access and have not changed any setting. Each item needs your action or an
explicit instruction. Nothing here is verified.

| Setting | Required value | Status |
|---|---|---|
| Email confirmation | On (customers must confirm before sign-in) | NOT DONE |
| Minimum password length | 12, matching `PASSWORD_MIN_CHARACTERS` | NOT DONE |
| Password recovery | Enabled, with the link expiry set to 30 minutes or less | NOT DONE |
| Session lifetime (JWT expiry) | 3600 seconds or less | NOT DONE |
| Refresh token reuse detection | On | NOT DONE |
| Redirect URLs | Only the GO production and development origins | NOT DONE |
| MFA (TOTP) | Enabled for the project. Staff enrol before a role is granted | NOT DONE |
| Auth rate limits | Keep Supabase defaults, review after launch | NOT DONE |
| Email templates | Copy the wording of GO's auth emails into Supabase's templates | NOT DONE |
| Custom SMTP | Not set up. Supabase's built-in mailer is for development only and is rate limited. A custom SMTP provider needs your approval, because most providers are paid | NOT APPROVED |
| Signing keys | Confirm the project's JWT format and `aal` claim against a real token before relying on it | NOT VERIFIED |
| Staff account creation | Disable public sign-up for staff roles. Staff accounts are created by an admin | NOT DONE |

## 5. Test evidence

- Unit tests: 603 of 603 pass (`npm run test:unit`), including 41 new in the follow-up (reset rules, frontend).
- Database checks: all RLS and constraint checks pass on a local PostgreSQL 16 cluster
  (`scripts/test-db.sh`), including the new checks 20a to 22d.
- Supabase dev project: migrations applied; security advisors show only intended findings
  (the RLS helper functions signed-in users need, and the webhook table, which has RLS and no policies
  on purpose).
- Strict type check of `packages/auth/src` shows no errors except missing Node type definitions,
  which this environment cannot install.
- Production build: NOT RUN. The repo has no build configuration, no framework and no application
  shell, and package installs are blocked here.

## 6. Security findings

1. **Role escalation** (fixed): a support member could not change roles before, but an admin role
   alone was enough. Role changes now need an MFA session.
2. **Staff without MFA** (fixed): a staff role can now be granted only to an account with a verified
   factor (database trigger), and the server refuses any staff request from an account without one.
3. **Operations passenger access** (fixed): operations could have been granted passenger access through
   the assignment function. The function now refuses operations.
4. **Trigger function exposed through the API** (fixed): found by the advisor and revoked.
5. **Login throttling is in memory** (open). It holds for one instance only. Supabase's own limits
   apply in the dashboard. A shared store is needed before more than one instance runs.
6. **Staff MFA recovery** (open). If a staff member loses every factor, an admin must reset it through
   a logged server path. That path is designed here but not built, and it needs a written procedure. How
   Supabase handles re-enrolment is not verified.
7. **Revoked staff access** (partly). A removed role or a lost factor is refused at the next request,
   but an existing token stays valid until it expires (one hour by default). Immediate revocation would
   need a session deny-list, which is not built.
8. **Customer MFA optional** (accepted, as you approved). Customer MFA UI is not built.
9. **Account lockout can be used against a customer** (accepted trade-off). Repeated failures on one
   account block that account's sign-in for 15 minutes. This was chosen to limit guessing.
10. **Passenger details still stored in plain text** (open, from phase 14). Date of birth and nationality
    are not yet encrypted, pending your decision on key management.

## 7. Not built, and why

- **Frontend, protected pages, sign-up and sign-in screens, and MFA enrolment screens.** There is no
  application shell, and package installs are blocked. These need a build step first.
- **Production build.** Not possible until the frontend exists.
- **Staff MFA recovery procedure and admin reset path.** Designed in section 6, not built.
- **Immediate session revocation.** Needs a deny-list; see finding 7.

## 8. Decisions for you

- [ ] Approve section 4: configure the Supabase dashboard yourself, or tell me to proceed if you give
      explicit instruction for the dashboard. I will not change settings without it.
- [ ] Approve or refuse a custom SMTP provider for authentication emails.
- [ ] Decide the staff MFA recovery procedure (who can reset a staff factor, and how identity is checked).
- [ ] Decide whether the frontend starts now, given the build restriction.
- [ ] Approve committing this phase (the branch and push question from earlier still stands).

## 9. Staff MFA reset (owner decision 3, built in phase 15 follow-up)

Only a designated super administrator may start a reset. Designation is server work (service role). The
designated account must be an administrator with a verified MFA method.

Steps (each one is audited in `audit_log`):
1. **Request** (super administrator, MFA session): `request_staff_mfa_reset(target, reason)`. The reason must be
   20 to 1000 characters. A super administrator cannot reset their own factor or be the target.
2. **Identity check** (a different super administrator, MFA session): `verify_staff_mfa_reset_identity(reset, method)`.
   Method is one of `in_person`, `video_call_with_photo_id`, `callback_to_registered_number`. No ID number or photo
   is stored. The requester cannot verify their own request.
3. **Notice** (server, service role): tell the affected staff member through the notification path, before any
   factor is removed. The notice time is recorded on the reset. This needs a delivery method that reaches staff
   (see docs/21, section 3).
4. **Remove factors** (server, service role, Supabase Admin API). Not built. The Admin API method and its behaviour
   are not verified in this environment.
5. **Complete** (a third super administrator, not the requester): `complete_staff_mfa_reset(reset)`. Requires steps 2
   and 3. The database refuses completion by the requester.
6. **Cancel** (any active super administrator): `cancel_staff_mfa_reset(reset)` while the reset is open.

Rules enforced by the database: at least two active super administrators must remain. A revoked designation cannot
be restored; designate again instead. Reset records are readable only by super administrators in an MFA session.

Tests: 18 RLS checks (30a to 30p, and 31a to 31b) and the TypeScript decision tests in `mfa-reset.test.ts`.

## 10. Super administrator recovery (separate procedure, not a staff reset)

A super administrator who loses every factor cannot be reset through the staff process. The database refuses it, and
that is deliberate. Recovery needs two other super administrators, plus a written record kept outside the system.

Procedure (to be signed off by you before first use):
1. The affected super administrator tells the other active super administrators through a channel they already trust
   (not email alone). Both confirm the identity of the person in a live call with photo ID shown.
2. Two active super administrators, other than the affected person, agree in writing, with a reason and the date.
3. The project owner, using the Supabase dashboard as the account holder, removes the affected account's factors.
   The owner records the action in the offline recovery register. This step needs the owner's own MFA.
4. The affected person enrols a new factor at first sign-in.
5. The register entry is closed, and an entry is recorded in `audit_log` by a super administrator (manual insert
   through the service path, if the team chooses).

If fewer than two super administrators remain, recovery must go through step 3 alone, with the reason and identity
checks recorded in the register. This is the highest-risk path. Keep at least three super administrators designated
once staff numbers allow.

## 11. Supabase dashboard steps (manual; nothing below has been done by me)

Menu names can change in the Supabase dashboard. Confirm each step against the current documentation before you act.
I have no dashboard access, and the sandbox cannot read the project's auth settings, so none of these is verified.

1. Authentication, Sign In / Providers: Email enabled. Turn on "Confirm email". Set the minimum password length to 12.
   Security impact: unconfirmed accounts cannot sign in. Length 12 matches the server rule.
2. Authentication, Sign In / Providers, Multi-Factor: TOTP enabled (it is on by default for projects; confirm).
   Security impact: staff need a verified factor before a staff role is granted.
3. Authentication, URL Configuration: Site URL set to the GO origin. Add only the GO production and development origins
   to the redirect allow-list. Security impact: a recovery or confirmation link can only return to a GO origin.
4. Authentication, Sessions (or JWT settings): JWT expiry 3600 seconds or less. Refresh token reuse detection on.
   Security impact: shorter access tokens limit the window after a sign-out or role removal.
5. Authentication, Rate Limits: keep defaults for now and review after launch. Note the default email limit (docs/21).
6. Authentication, Email Templates: paste the wording of GO's account emails (confirmation, reset), with the same
   content as `packages/notify/src/templates.ts`. Do not add personal data to templates.
7. Authentication, Sign Up: disable public sign-up for staff roles if the dashboard allows it. Staff accounts are
   created by an administrator only. Security impact: no one can create a staff account from the public form.
8. Authentication, SMTP: leave the default for development. Do not enable a custom provider until approved.

Record here, when done, the date and the name of the person who made each change: __________

Until these steps are complete and checked against a live test account, the configuration is NOT verified.
