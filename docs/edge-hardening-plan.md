# Edge Hardening Plan — Cloudflare WAF in front of the Cloud Functions

Status: **planning** (no implementation yet)
Author: stein
Last updated: 2026-10-01

Harden the externally-reachable Cloud Functions against abuse by fronting the
inbound **webhooks** with Cloudflare (peblet.be) for rate limiting, bot
mitigation, and a cheap edge check that `X-Twilio-Signature` is present —
while keeping the cryptographic signature check in the function as the real
gate. Includes a **zero-downtime migration** for existing users whose Twilio
numbers already point at the current `*.cloudfunctions.net` URLs.

---

## 1. Guiding facts from the current codebase

- **Gen2 functions** (`firebase-functions/v2`), project `twilio-phone-peblet`,
  region `europe-west1`. Gen2 HTTP functions are Cloud Run services under the
  hood — reachable at **both** `europe-west1-twilio-phone-peblet.cloudfunctions.net/<fn>`
  **and** a `*.run.app` URL. Both are public by default.
- **Externally-reachable, unauthenticated HTTP endpoints** (`onRequest`, no App
  Check — this is the abuse surface):
  | Function | Role | Current guard |
  |---|---|---|
  | `twilioIncomingCall` | inbound PSTN voice (TwiML App `voiceUrl`) | signature guard, **fail-open** |
  | `twilioOutgoingCall` | outbound voice (TwiML App `voiceUrl`) | signature guard, **fail-open** |
  | `twilioCallStatusChanges` | voice status callback | signature guard, **fail-open** |
  | `twilioIncomingMessage` | inbound SMS/MMS (`smsUrl`) | signature guard, **fail-open** |
  | `twilioAppleNotifications` | App Store Server Notifications V2 | **none** — only checks `signedPayload` is a string (JWS verify is a TODO; `index.ts:229`) |
- **All 9 `onCall` functions already enforce App Check** (`enforceAppCheck: true`)
  and most are further gated (ownership proof in `linkTwilioAccount`,
  subscription gate in `twilioAccessToken`). They are **out of scope** for the
  Cloudflare fronting; App Check + a cost ceiling (§6.6) covers them.
- `onPlaySubscriptionNotification` is **Pub/Sub-triggered**, not HTTP-exposed —
  protected by IAM, nothing to do.
- **Signature validation already exists** (`twilio.ts` `isValidTwilioSignature`,
  `twilioSignatureGuard`) for the 4 Twilio webhooks. It validates against a
  **static URL constant** (`FUNCTIONS_BASE_URL`, `twilio.ts:18`), deliberately
  *not* reconstructing the URL from proxy-rewritten headers. **This is the single
  most important fact for this plan** — it means putting a proxy in front does
  not break validation, as long as the constant matches what Twilio is told to
  call.
- Validation is **fail-open** for tenants with no stored Auth Token, and
  `rememberAuthToken` persists the token on `twilioRegister` / `twilioAccessToken`.
  Since `twilioAccessToken` is on the hot path (600 s token TTL), **active users
  already have, or imminently get, a stored token** — the fail-open window
  closes on its own for anyone using the app.
- **`FUNCTIONS_BASE_URL` is used for two distinct jobs:** (a) the URL written
  *into* Twilio (`getOrCreateTwimlApp` `voiceUrl`, `configureNumber`
  `statusCallback`/`smsUrl`), and (b) the URL we *validate against*. The
  migration must treat these two jobs separately.
- Twilio signs **HMAC-SHA1 over `URL + the alphabetically-sorted POST params`**,
  base64. Consequences: the proxy must not alter the body, add query params, or
  change the path, or every signature breaks.

---

## 2. Goals and non-goals

The two objectives, and the layer each lives in:

1. **Prevent unauthorized calls to the functions.** Enforced *in the function*,
   so it holds on every path (through Cloudflare or direct to the origin): the
   Twilio HMAC signature and Apple JWS are the authoritative gate — a forged call
   can't produce a valid one. Requires (a) adding **Apple JWS verification**
   (`twilioAppleNotifications` has none today), and (b) making the Twilio
   signature check **fail-closed** once tokens are backfilled (§6.1a) — today it
   fail-opens for an `AccountSid` with no stored token, so a made-up SID passes.
2. **The option to block untrusted actors at the WAF.** Enforced *at Cloudflare*,
   for traffic routed through `dialcrest-hooks.peblet.be`: IP/ASN/geo blocks,
   rate limits, bot rules, and an edge drop of requests missing
   `X-Twilio-Signature`. This is why the webhooks must be fronted at all — the WAF
   can only act on traffic that passes through it.

Supporting goals: migrate existing tenants with **zero downtime** and a clean
rollback; keep direct-to-origin from silently bypassing the WAF (the
`X-Origin-Auth` header, §5.3).

**Non-goals (this round)**
- Fronting the `onCall` callables through Cloudflare (App Check already gates
  them; would require a Flutter client change). Covered only by a cost ceiling.
- No **Google Load Balancer / Cloud Armor** anywhere. The raw-origin exposure is
  removed instead by migrating the Twilio webhooks to a **Cloudflare Worker** and
  deleting the functions (§14) — the WAF lives entirely at Cloudflare.
- Edge-only authentication — Cloudflare can check the *presence* of a signature,
  never its *validity* (it lacks each tenant's Auth Token), so the in-function
  check stays the authority.

**Threat model.** (a) Volumetric abuse / cost-amplification against the public
webhook URLs; (b) forged webhook payloads driving call/SMS routing or
subscription state; (c) scanner/bot noise. Not in scope: a compromised tenant
Twilio account, or Google-infrastructure DoS.

---

## 3. The two constraints that shape everything

1. **Validation URL must equal the configured URL.** If Twilio is told to call
   `https://dialcrest-hooks.peblet.be/twilioIncomingCall`, the function must validate
   against that exact string. Moving the host therefore requires changing both
   the Twilio-side config (per tenant) and the validation constant — and because
   those roll out at different speeds, the function must **accept both the old
   and the new URL during the transition** (§6.1).

2. **The origin stays directly reachable.** Pointing DNS at Cloudflare does not
   stop anyone from hitting `*.cloudfunctions.net` / `*.run.app` directly and
   bypassing the WAF. **Fronting is pointless for abuse protection unless the
   origin is locked** so it only answers requests that came through Cloudflare
   (§5.3). The in-function signature check still protects correctness on the
   direct path, but *cost/volume* protection requires the origin lock.

---

## 4. Target hostname

Use a dedicated subdomain so WAF policy, caching, and bot rules are scoped away
from the website (`dialcrest.peblet.be`):

```
dialcrest-hooks.peblet.be   →  the webhooks, path-for-path
```

Path mapping is 1:1 with the function names, e.g.
`https://dialcrest-hooks.peblet.be/twilioIncomingCall`. No path rewriting
(rewriting would break the Twilio signature).

**Why this name and not `hooks.dialcrest.peblet.be`.** The nested name reads
nicer (groups under the `dialcrest` product), but Cloudflare's free **Universal
SSL** covers only `peblet.be` and **one** wildcard level, `*.peblet.be`:
`dialcrest-hooks.peblet.be` is a first-level subdomain → **covered free**;
`hooks.dialcrest.peblet.be` is second-level → **not** on that wildcard, so a
proxied record there would need paid **Advanced Certificate Manager (~$10/mo)**.
A **Workers Custom Domain** (§14) provisions a per-hostname cert and *may* issue
the second-level name free — verify in the dashboard before choosing it. Default
to the first-level name; it matches the cost priorities and is guaranteed free.

---

## 5. Cloudflare architecture

### 5.1 Fronting — how dialcrest-hooks.peblet.be reaches the functions

**Decided: the cheap path (no GCP infra).** Orange-cloud
`dialcrest-hooks.peblet.be`; a Cloudflare **Origin Rule** overrides the Host
header / SNI to `europe-west1-twilio-phone-peblet.cloudfunctions.net` so Google's
frontend routes the request. No Google Load Balancer, no serverless NEG — cost is
just the Cloudflare plan. Origin lock is via the shared-secret header (§5.3),
which works on this setup against both the `*.cloudfunctions.net` and `*.run.app`
URLs.

> End-state (§14): migrating the Twilio webhooks to a Cloudflare **Worker** and
> deleting the functions **removes the raw `*.cloudfunctions.net` origin entirely**
> — so there's nothing left to proxy, host-override, or origin-lock for those
> paths. This §5 fronting is the **interim** hardening while the webhooks still
> live on functions. ~$0–5/mo, no Google infra.

SSL/TLS mode **Full (strict)**. Do **not** let any rule add query params or
rewrite the body/path on these routes.

### 5.2 WAF / rate-limit rules (scoped to dialcrest-hooks.peblet.be)

Expression helper — the four Twilio paths:
`http.request.uri.path in {"/twilioIncomingCall" "/twilioOutgoingCall" "/twilioCallStatusChanges" "/twilioIncomingMessage"}`

- **Require the signature header** (Twilio paths): if
  `not any(http.request.headers["x-twilio-signature"][*] ne "")` → **block**.
  Cheap edge drop of scanners; the function still does the real HMAC check.
- **Method + content-type**: block non-`POST`; expect
  `application/x-www-form-urlencoded`.
- **Rate limiting**: a global per-path ceiling plus a per-IP rule. Note Twilio
  calls arrive from a **bounded set of Twilio egress IPs**, so a naive per-IP
  limit can throttle legit traffic — prefer a generous per-IP limit + a stricter
  global path ceiling. On Business+ you can rate-limit by the `AccountSid` form
  field (body-field matching) for per-tenant fairness. These rules run **before**
  the origin/Worker and are flat-rate, so blocked abuse never invokes it — which
  is also what shields the Workers-Free daily budget under attack (§14, "Hard cost
  ceiling").
- **Bots**: use **block, never JS/managed challenge**, on webhook paths — Twilio
  and Apple won't solve challenges. Exclude these paths from Bot Fight / Super
  Bot Fight Mode; set Security Level low here and rely on explicit rules.
- **Optional IP allowlist**: restrict Twilio paths to Twilio's published webhook
  IP ranges. Stronger, but Twilio **recommends signature validation over IP
  allowlisting** because the ranges change — treat as optional, with a
  maintenance owner, not the primary control.
- **Apple path** (`/twilioAppleNotifications`): POST-only + small-body + rate
  limit; the real gate is JWS verification (§6.4). Apple has no stable published
  source range — do not IP-allowlist it.

### 5.3 Origin lock (close the direct-to-origin bypass)

**Interim measure (webhooks-still-on-functions only).** Cloudflare adds
`X-Origin-Auth: <secret>` via a **Transform Rule**; the functions reject any
request lacking it (§6.5). Works against both the `*.cloudfunctions.net` and
`*.run.app` URLs. The secret can leak, so rotate it periodically — but combined
with the in-function signature check it's solid for cost/abuse protection.

This matters only while the webhooks live on Cloud Functions: relying on
in-function signature validation **alone** keeps correctness safe but still lets
attackers flood the origin directly and run up invocations. The **end-state
(§14)** retires this header for the Twilio webhooks entirely — once they're a
Worker and the functions are deleted, there is no separate origin to lock.

---

## 6. Code changes (functions/)

### 6.1 Dual-URL signature validation — *do this first, it's purely additive*
`twilio.ts`: replace the single `signedUrl` compare in `isValidTwilioSignature`
with an **accept-list of base URLs**; return true if the signature validates
against *any* of them. Seed the list with the legacy host and the new host.
This is what makes the migration break-free: a number may call either host at
any point in the transition and still validate.

### 6.1a Close the fail-open — the core of "prevent unauthorized calls"
`isValidTwilioSignature` currently returns `true` when the request's `AccountSid`
has **no stored Auth Token** (migration grace; `twilio.ts`), so a made-up SID
passes the guard today. Once the backfill (Phase 4) has stored tokens for the
active base, flip this to **fail-closed**: no stored token → **reject**. Gate the
flip behind a param (`TWILIO_SIGNATURE_FAIL_CLOSED`, default off) so it's a config
change, not a redeploy, and so §8's "tokenless `AccountSid`" counter can confirm
the active base is covered first. After the flip, every Twilio webhook call must
carry a signature that validates against a *known* tenant's token — unknown or
unsigned SIDs are rejected. This, not the WAF, is what actually prevents
unauthorized calls (the WAF can't see the per-tenant token).

### 6.2 Config-drive the hosts (stop hardcoding)
Introduce two params (`defineString`, env-overridable for emulator/staging):
- `WEBHOOK_PUBLIC_BASE_URL` — the host we **write into** Twilio (and validate).
  Defaults initially to the legacy cloudfunctions host, flips to
  `https://dialcrest-hooks.peblet.be` at cutover.
- `WEBHOOK_LEGACY_BASE_URLS` — extra hosts we still **accept** during migration
  (the cloudfunctions host; add the `run.app` host if it was ever used).

`OUTGOING_CALL_URL` / `INCOMING_CALL_URL` / `STATUS_CALLBACK_URL` /
`INCOMING_MESSAGE_URL` derive from `WEBHOOK_PUBLIC_BASE_URL`;
`isValidTwilioSignature` validates against `{public} ∪ {legacy...}`.

### 6.3 Self-heal existing Twilio config to the new host
Existing TwiML Apps and numbers keep the old URLs — the cached TwiML App SID's
`voiceUrl` is never re-checked on hot paths, and numbers carry
`statusCallback`/`smsUrl` directly. Add a cheap, idempotent re-point triggered
from the callables the app already hits (`twilioAccessToken`,
`twilioGetIncomingAppSid`, `twilioConfigureNumbers`):
- Store a per-tenant `webhookUrlVersion` marker in RTDB. On a callable, one RTDB
  read; if the marker is current, do nothing (bounds hot-path cost).
- If stale: `applications(sid).update({voiceUrl})` for the tenant's **incoming
  and outgoing** TwiML Apps, and `incomingPhoneNumbers(sid).update({statusCallback, smsUrl})`
  for numbers this tenant configured (those with an `original` snapshot, or whose
  `voiceApplicationSid` is our incoming app). Then set the marker.
- Uses the **live token already passed to the callable** — so it needs no stored
  token and self-migrates every active user. Re-running `configureNumber`'s
  snapshot is already guarded ("write only if not exists"), so this won't corrupt
  the restore snapshot.

### 6.4 Apple JWS verification (`twilioAppleNotifications`)
Implement real verification with `app-store-server-library`
(`SignedDataVerifier`) against Apple's root CAs before processing — reconciling
the README, which already *claims* this happens (`README.md:306`) while the code
only checks the payload is a string. Independent of Cloudflare; do it regardless.

### 6.5 Origin-secret guard (§5.3) — interim only
Add a small guard on the webhooks: reject with 403 if `X-Origin-Auth` ≠ the
configured secret. Store the secret in the existing `TWILIO_PEBLET_SECRET` JSON
(new property) or a dedicated secret param. Apply **before** heavier work; keep
it a constant-time compare. This is the interim origin lock while the webhooks
run on functions; the §14 Worker end-state removes the need for it on the Twilio
paths (it can stay on the Apple function if you front that too).

### 6.6 Cost ceiling (defence-in-depth, independent of Cloudflare)
Set `maxInstances` on the webhook functions (and the callables) so a flood has a
hard, bounded cost even if it reaches the origin; keep `minInstances: 0`.
Consider per-function `concurrency`. This is the backstop for the
not-fronted callables and for any direct-origin traffic.

### 6.7 Tests (`twilio.test.ts`)
- Dual-URL: valid signature for the **new** host accepted; for the **legacy**
  host still accepted; unknown host rejected (token stored).
- Origin-secret guard: missing/wrong `X-Origin-Auth` → 403; correct → passes to
  signature check.
- Self-heal: stale marker triggers the updates once and flips the marker; current
  marker is a no-op; snapshot not re-written.
- Apple JWS: forged/altered payload rejected; genuine accepted (fixtures).

---

## 7. Migration — zero-downtime, phased

Each phase is independently deployable and reversible. The invariant that keeps
it safe: **dual-URL acceptance (6.1) ships before anything is re-pointed**, so no
tenant ever has a moment where its signature fails.

**Phase 0 — Prep.** Fronting and origin lock are already decided (cheap path +
shared-secret header, §5). No behavior change.

**Phase 1 — Deploy dual-URL validation + config params + origin-secret guard
(initially in log-only/allow mode) + Apple JWS.** `WEBHOOK_PUBLIC_BASE_URL`
still = legacy host, so nothing re-points yet. Purely additive; affects no
tenant. The backend now *tolerates* the new host before any traffic uses it.

**Phase 2 — Stand up Cloudflare `dialcrest-hooks.peblet.be`** (manual runbook in
§12). SSL Full (strict), WAF + rate-limit rules, Transform Rule injecting
`X-Origin-Auth`. Nobody is pointed at it yet → zero tenant risk. Verify by
`curl`-signing a test request to `https://dialcrest-hooks.peblet.be/...` and
confirming it validates and that a request *without* `X-Origin-Auth` (straight to
the origin) is rejected once the guard is switched from log-only to enforce.

**Phase 3 — Flip `WEBHOOK_PUBLIC_BASE_URL` → `https://dialcrest-hooks.peblet.be`.** Now:
- **New** tenants / numbers / TwiML Apps are written with the new host and
  validate against it (it's the public base).
- **Existing** tenants self-heal (6.3) the next time their app calls a callable —
  active users migrate within one app session, each flipping independently.
  Because the legacy host is still in the accept-list, a not-yet-migrated tenant
  keeps working on the old URL until it flips.

**Phase 4 — Backfill the long tail.** A one-off admin routine (restricted
callable or Admin-SDK script) iterates tenants in RTDB and, using the
`rememberAuthToken`-stored token, pushes the same re-point as 6.3 for tenants
who haven't opened the app. Tenants with no stored token are unreachable until
they next open the app — acceptable, they still work on the legacy URL.

**Phase 5 — Apple.** In App Store Connect, set the ASSN **Production and Sandbox**
URLs to `https://dialcrest-hooks.peblet.be/twilioAppleNotifications`. Apple's JWS is
host-independent, so this is just a console change plus Phase-1's JWS verify.

**Phase 6 — Tighten and clean up.** When telemetry (§8) shows ~no traffic on the
legacy host and the tokenless-`AccountSid` counter is ≈ 0 for the active base:
- **Flip `TWILIO_SIGNATURE_FAIL_CLOSED` on** (§6.1a) — this is the step that
  turns "prevent unauthorized calls" from mostly-true into enforced.
- Switch the origin-secret guard from log-only to enforce (if not already).
- Drop the legacy host from the accept-list (`WEBHOOK_LEGACY_BASE_URLS`); update
  the README URLs.

---

## 8. Observability and exit criteria

- **Which host validated.** In `isValidTwilioSignature`, log (sampled) whether
  the legacy or public base matched, with `AccountSid`. Count legacy-vs-public to
  know when Phase 6 is safe.
- **Tokenless `AccountSid`.** Count webhook calls that hit the fail-open branch
  (known-vs-unknown SID). This tells you when it's safe to flip
  `TWILIO_SIGNATURE_FAIL_CLOSED` (§6.1a): near-zero for real tenants = the active
  base has stored tokens; any residual is the junk the flip will start rejecting.
- **Origin-secret guard** starts in **log-only** (count requests lacking
  `X-Origin-Auth` = direct-origin traffic) before switching to enforce, so you
  don't black-hole a forgotten caller.
- **Cloudflare analytics** for blocked / rate-limited / challenged counts per
  rule; watch for false positives on legit Twilio/Apple IPs.
- **Exit criteria for Phase 6:** legacy-host validations ≈ 0 for N days;
  tokenless-`AccountSid` ≈ 0 for real tenants (safe to fail-closed); no
  `X-Origin-Auth`-missing requests except known abuse; Cloudflare block rate
  steady with no legit-traffic false positives.

---

## 9. Rollback

- **Phase 1** is additive — nothing to roll back.
- **Cloudflare/WAF too aggressive:** loosen/disable the specific rule, or set the
  `dialcrest-hooks.peblet.be` record to **DNS-only (grey cloud)** to bypass the WAF while
  keeping it resolving. (If grey-cloud can't route to the origin due to host
  mismatch, fall back to the next point.)
- **New host misbehaving:** revert `WEBHOOK_PUBLIC_BASE_URL` to the legacy host
  and redeploy; because the legacy host is still in the accept-list and
  self-heal re-points tenants back, traffic returns to `*.cloudfunctions.net`
  cleanly.
- **Origin-secret guard wrong:** flip it back to log-only.
- Dual-URL acceptance is the net under the whole trapeze — keep it until Phase 6.

---

## 10. Open decisions / cost

Interim fronting + origin lock are **decided** (Cloudflare proxy §5.1 +
shared-secret header §5.3); the end-state is the **Worker migration (§14)**, which
removes the origin for the Twilio webhooks. No Google infrastructure either way.
Remaining choices:

- **Interim vs straight-to-Worker.** Ship Tier A (interim hardening) first for
  fast risk reduction, then Tier B (§14); or, if the Worker port is ready, skip
  the `X-Origin-Auth`/Origin-Rule interim and go straight to the Worker. Both
  reuse the same tenant re-point (§6.3/§7).
- **Hostname cert** (§4): `dialcrest-hooks.peblet.be` is free; confirm whether a
  Workers Custom Domain issues `hooks.dialcrest.peblet.be` free before preferring
  the nested name.
- **Cloudflare plan**: signature-presence + basic rate limiting work on low/Pro
  tiers; **per-`AccountSid` body-field** rate limiting needs Business+.
- **IP allowlisting** Twilio ranges — opt-in, needs a maintenance owner.
- Where to store `X-Origin-Auth` (interim) and the Worker's SA key / rotation.

---

## 11. Manual runbook (things only you can do)

These are the console/CLI actions outside the codebase. Do them during **Phase 2**
(§7), after Phase 1 is deployed so the endpoints exist. Nothing here points a
tenant at the new host, so it's all zero-risk until Phase 3.

### 11.0 Prep
- **Generate the origin secret** (the value Cloudflare injects and the function
  checks):
  ```bash
  openssl rand -hex 32          # copy the output; call it ORIGIN_SECRET below
  ```
- Confirm the functions are deployed (`firebase deploy --only functions`) so
  `europe-west1-twilio-phone-peblet.cloudfunctions.net/<fn>` responds.

### 11.1 Cloudflare — DNS
1. **DNS → Records → Add record**: Type `CNAME`, Name `dialcrest-hooks`, Target
   `europe-west1-twilio-phone-peblet.cloudfunctions.net`, **Proxy status: Proxied
   (orange cloud)**, TTL Auto.
   - The edge cert is covered by Cloudflare Universal SSL's `*.peblet.be` — no
     extra cert step for a first-level subdomain.

### 11.2 Cloudflare — SSL/TLS
2. **SSL/TLS → Overview → set mode to `Full (strict)`.**

### 11.3 Cloudflare — Origin Rule (route to Google)
A proxied CNAME still sends `Host: dialcrest-hooks.peblet.be`, which Google's
frontend won't route. Override it:
3. **Rules → Origin Rules → Create rule.**
   - When incoming requests match: `Hostname` `equals` `dialcrest-hooks.peblet.be`.
   - Then: **Host Header → Rewrite to** `europe-west1-twilio-phone-peblet.cloudfunctions.net`,
     and **SNI → Rewrite to** the same value.
   - Deploy. Hitting `https://dialcrest-hooks.peblet.be/twilioIncomingCall` should
     now reach the function (a signed test still needed to pass validation).

### 11.4 Cloudflare — Transform Rule (inject the origin secret)
4. **Rules → Transform Rules → Modify Request Header → Create rule.**
   - When: `Hostname` `equals` `dialcrest-hooks.peblet.be`.
   - Then → **Set static**: Header name `X-Origin-Auth`, Value `ORIGIN_SECRET`
     (from 11.0). (Optionally store it as a Cloudflare **Secret** and reference it,
     so it isn't shown in plaintext in the rule.)

### 11.5 Cloudflare — WAF custom rules
5. **Security → WAF → Custom rules → Create rule** — *Block bad webhook shape*:
   ```
   (http.host eq "dialcrest-hooks.peblet.be"
    and http.request.uri.path in {"/twilioIncomingCall" "/twilioOutgoingCall" "/twilioCallStatusChanges" "/twilioIncomingMessage"}
    and (http.request.method ne "POST"
         or not any(http.request.headers["x-twilio-signature"][*] != "")))
   ```
   Action **Block**. (Drops non-POST and any request missing `X-Twilio-Signature`
   before it costs an invocation; the function still does the real HMAC check.)
6. *(Optional)* A second rule for the Apple path: Block if
   `http.host eq "dialcrest-hooks.peblet.be" and http.request.uri.path eq "/twilioAppleNotifications" and http.request.method ne "POST"`.

### 11.6 Cloudflare — Rate limiting
7. **Security → WAF → Rate limiting rules → Create rule.**
   - When: `http.host eq "dialcrest-hooks.peblet.be"`.
   - Characteristics: **IP**; Period **10s** (or 1m); start generous (Twilio
     arrives from a bounded IP set, so a tight per-IP limit throttles legit
     traffic). Suggested starting point: 100 req / 10s per IP → **Managed
     Challenge is wrong here → choose action Block**.
   - Add a second, stricter **global path** ceiling (no IP characteristic) as the
     volumetric backstop.
   - *(Business+ only)* a per-tenant rule keyed on the `AccountSid` form field.

### 11.7 Cloudflare — bots / security level (avoid blocking Twilio & Apple)
8. **Security → Bots:** ensure **Bot Fight Mode / Super Bot Fight Mode does not
   challenge** `dialcrest-hooks.peblet.be` (Twilio/Apple can't solve JS or managed
   challenges). If you can't scope it, add a WAF **Skip** rule for the host that
   skips Super Bot Fight Mode, and rely on the rules above.
9. **Security → Settings:** set Security Level **Essentially Off / Low** for this
   host (via a Configuration Rule scoped to the hostname) so the Under-Attack/Browser
   checks never challenge a webhook.

### 11.8 Google Cloud — origin lock on the cheap path
On this (no-Load-Balancer) design, the origin lock is the **`X-Origin-Auth` check
in the function** (§6.5), *not* a GCP network control — the functions must stay
publicly invokable because Twilio/Apple can't present a Google IAM token. So the
Google-side manual actions are:
10. **Store the secret** the function reads, matching 11.0. If reusing
    `TWILIO_PEBLET_SECRET`, add an `origin_auth` property to its JSON and re-set it:
    ```bash
    firebase functions:secrets:set TWILIO_PEBLET_SECRET   # paste JSON incl. "origin_auth":"<ORIGIN_SECRET>"
    ```
    (or a dedicated secret if you prefer: `firebase functions:secrets:set WEBHOOK_ORIGIN_AUTH`).
11. **Cost ceiling** — confirm/set max instances on the webhook functions (also in
    code via §6.6; CLI form shown for a one-off):
    ```bash
    gcloud run services update twilioincomingcall   --region europe-west1 --max-instances 10
    # repeat for the other webhook services, or set maxInstances in the function options
    ```
12. **Leave invoker open** — webhooks need `allUsers` as Cloud Run invoker (already
    the case). Do **not** switch them to require auth; the secret header is the gate.

> To remove the raw `*.cloudfunctions.net` origin for the Twilio webhooks
> altogether (rather than guard it with the header above), migrate them to a
> Cloudflare **Worker** and delete the functions — the §14 end-state. No Google
> infrastructure; ~$0–5/mo.

### 11.9 Verify before any tenant is re-pointed
13. **Signed request passes through Cloudflare** (replace values; sign with a test
    tenant's Auth Token using Twilio's algorithm — HMAC-SHA1 over URL + sorted
    params, base64):
    ```bash
    # Expect HTTP 200 and valid TwiML
    curl -i -X POST https://dialcrest-hooks.peblet.be/twilioIncomingCall \
      -H 'X-Twilio-Signature: <computed>' \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data 'AccountSid=AC...&From=%2B32...&To=%2B32...'
    ```
14. **Edge drops a header-less request** (expect Cloudflare **403/blocked**, no
    invocation): same `curl` without `-H 'X-Twilio-Signature: ...'`.
15. **Direct-to-origin is rejected once the guard enforces** (expect **403** from
    the function, because Cloudflare's `X-Origin-Auth` is absent):
    ```bash
    curl -i -X POST https://europe-west1-twilio-phone-peblet.cloudfunctions.net/twilioIncomingCall \
      -H 'X-Twilio-Signature: <computed>' --data '...'
    ```
    (Keep the guard in **log-only** until §8's counters show no surprise callers,
    then flip to enforce.)

### 11.10 Apple (Phase 5, manual)
16. **App Store Connect → your app → App Information → App Store Server
    Notifications (V2):** set **both** Production and Sandbox URLs to
    `https://dialcrest-hooks.peblet.be/twilioAppleNotifications`. Twilio number
    re-pointing is automatic (self-heal §6.3) — no Twilio console work.

---

## 12. Future-proofing — AGENTS.md / CLAUDE.md guardrails

There is **no `AGENTS.md` or `CLAUDE.md`** in the repo today. Create an
**`AGENTS.md`** at the repo root (read by Claude Code and other coding agents) so
future changes don't silently regress this hardening, and add a one-line
`CLAUDE.md` that points at it (`See AGENTS.md`). Add a **Security invariants**
section with this content:

```markdown
## Security invariants — externally-reachable Cloud Functions

Read docs/edge-hardening-plan.md before touching functions/src/twilio.ts or
functions/src/index.ts. These rules must not be broken:

- **No unauthenticated public endpoint.** Every `onRequest` function must, before
  doing any work, (1) pass the `X-Origin-Auth` origin-secret guard, and (2)
  authenticate the payload — Twilio `X-Twilio-Signature`, Apple JWS, or Pub/Sub
  IAM. Never add a public endpoint that skips both.
- **Don't reintroduce the signature fail-open.** Once `TWILIO_SIGNATURE_FAIL_CLOSED`
  is on, an `AccountSid` with no stored token must be rejected, not allowed. The
  fail-open was a one-time migration grace.
- **Callables keep `enforceAppCheck: true`.** Don't remove it.
- **One source of truth for the webhook host.** `WEBHOOK_PUBLIC_BASE_URL` is the
  host both written into Twilio and validated against. If you change it, the old
  host MUST stay in `WEBHOOK_LEGACY_BASE_URLS` until traffic drains, or you break
  every existing tenant's signature (Twilio signs the exact configured URL).
- **Validate against the static URL constant — never reconstruct the URL** from
  request headers (`X-Forwarded-Host`, `Host`, …); those are proxy-spoofable.
- **Don't let anything alter the webhook body, path, or query string.** The Twilio
  HMAC is computed over URL + sorted POST params; any rewrite breaks validation.
  This constrains Cloudflare rules too (no added query params, no path rewrite).
- **Third-party webhooks go under dialcrest-hooks.peblet.be**, never a raw
  *.cloudfunctions.net URL — otherwise they bypass the Cloudflare WAF.
- **Worker and functions must not drift.** The Twilio webhooks run in a Cloudflare
  Worker (docs/edge-hardening-plan.md §14); the TwiML shapes, `clientIdentity =
  accountSid`, RTDB paths, and FCM payload must stay identical to the Node code.
  Keep the pure bits in a shared module; don't fork them.
- **Set `maxInstances`** on any new public function (cost ceiling).
- **Rotating the origin secret** means updating the Cloudflare Transform Rule and
  the function secret together.
```

Keep `docs/edge-hardening-plan.md` as the detailed reference the guardrails point
to.

---

## 13. Checklist

**Tier A — interim hardening (webhooks stay on functions; ship first)**
- [ ] 6.1 Dual-URL signature validation + 6.7 tests
- [ ] 6.1a Fail-closed flip behind `TWILIO_SIGNATURE_FAIL_CLOSED` (default off)
- [ ] 6.2 `WEBHOOK_PUBLIC_BASE_URL` / `WEBHOOK_LEGACY_BASE_URLS` params
- [ ] 6.5 Origin-secret guard (log-only first)
- [ ] 6.4 Apple JWS verification + README reconcile
- [ ] 6.6 `maxInstances` on webhooks + callables
- [ ] 6.3 Self-heal re-point on callables (+ `webhookUrlVersion` marker)
- [ ] 8 Logging of matched host + guard log-only counters
- [ ] 12 Create `AGENTS.md` (+ `CLAUDE.md` pointer) with the security invariants
- [ ] Deploy **Phase 1**
- [ ] §11 Cloudflare: DNS proxied, SSL Full (strict), Origin Rule host/SNI override
- [ ] §11 Cloudflare: WAF rules (sig-present, method, bots), rate limits, Transform
      Rule `X-Origin-Auth`
- [ ] §11 Google Cloud: store `ORIGIN_SECRET`, set max-instances, leave invoker open
- [ ] §11.9 Verify: new host signs/validates; edge blocks header-less; origin
      rejects without `X-Origin-Auth`
- [ ] **Phase 3**: flip `WEBHOOK_PUBLIC_BASE_URL`; confirm self-heal on a test tenant
- [ ] **Phase 4**: backfill script for the long tail
- [ ] **Phase 5**: repoint Apple ASSN URLs (Prod + Sandbox)
- [ ] **Phase 6**: flip `TWILIO_SIGNATURE_FAIL_CLOSED` on, enforce origin lock,
      drop legacy host, update README

**Tier B — end-state: Twilio webhooks → Cloudflare Worker (§14; removes the raw origin)**
- [ ] Worker project + `wrangler`; `android_fcm` SA key as a Worker secret
- [ ] Port signature validation (WebCrypto HMAC-SHA1) + RTDB-REST + FCM-v1 helpers
- [ ] Shared TS module for the pure bits (TwiML builders, DB paths)
- [ ] Workers Custom Domain `dialcrest-hooks.peblet.be` (confirm cert is free)
- [ ] Migrate path-by-path (outgoing/status → incoming → message); smoke-test each
- [ ] Re-point tenants (reuse §6.3 self-heal + Phase-4 backfill); watch host counter
- [ ] Keep the Worker on **Workers Free** (hard 100k/day €0 ceiling); WAF
      rate-limit rules in front to shield the budget under attack (§14)
- [ ] Delete the four `onRequest` Twilio functions; drop their `X-Origin-Auth` guard

---

## 14. End-state — migrate the Twilio webhooks to Cloudflare Workers

This is how the raw-origin exposure is removed: not by *locking* the Cloud
Function origin, but by **deleting it**. Once the four Twilio webhooks run in a
Cloudflare Worker and the old `onRequest` functions are gone, there is **no raw
`*.cloudfunctions.net` webhook URL left to protect** — no ingress config, no
Google infrastructure, nothing to bypass. The Worker *is* the origin, it lives on
`dialcrest-hooks.peblet.be`, and the WAF / rate-limiting (§5.2) run in front of
it. No Google Load Balancer, no Cloud Armor.

**Scope:**
- **Twilio ×4 → Worker:** `twilioIncomingCall`, `twilioOutgoingCall`,
  `twilioCallStatusChanges`, `twilioIncomingMessage`.
- **`twilioAppleNotifications` stays a Cloud Function** (reasons below).
- **Callables stay Cloud Functions**, App Check-gated, untouched.

### What the Worker does
| Endpoint | Logic | Deps in the Worker |
|---|---|---|
| `twilioOutgoingCall` | `To`/`From` → TwiML `<Dial callerId>` | 1 RTDB read (token for sig) |
| `twilioIncomingCall` | read `trial/expiresAt` → TwiML `<Dial><Client>` | 2 RTDB reads |
| `twilioCallStatusChanges` | log / record | 1 RTDB read |
| `twilioIncomingMessage` | read `messaging-tokens` → **data-only FCM fan-out** | 2 RTDB reads + N FCM sends |

Two things the Worker hand-rolls (no `firebase-admin` in Workers):
- **Twilio signature validation** — ~10 lines of WebCrypto: HMAC-SHA1 over
  `URL + alphabetically-sorted POST params`, base64, constant-time compare.
  Reimplements `validateRequest` directly (don't pull the heavy `twilio` npm
  package). It validates against the real `https://dialcrest-hooks.peblet.be/...`
  the Worker actually sees — no Host-override needed.
- **Firebase via REST** — mint a Google OAuth token in the Worker (sign the
  service-account JWT with WebCrypto `RS256`, exchange at the token endpoint,
  cache ~1h), then call RTDB REST
  (`…firebaseio.com/twilio/<sid>/secret/authToken.json?access_token=…`) for the
  stored token + trial expiry, and FCM HTTP v1 (`…/messages:send`) for the SMS
  fan-out. The SA key (reuse `android_fcm`) lives in a `wrangler` secret.

The Worker calls **no Twilio REST API** — all local HMAC + RTDB + FCM — so it
stays small. Token storage is unchanged: the callables (still functions) keep
writing `/twilio/<sid>/secret/authToken` via `rememberAuthToken`; the Worker just
reads it. Fail-closed (§6.1a) lives in the Worker.

### Why it's worth it

**Voice latency — no cold starts.** `twilioIncomingCall` / `twilioOutgoingCall`
are *in the call path*: Twilio waits for the TwiML before it rings/connects, so
webhook latency is dead air the caller hears (status callbacks and SMS aren't in
that path, so their latency is invisible). Gen2 functions cold-start by booting a
container + Node runtime + the `firebase-admin`/`twilio`/`googleapis` require
chain — typically hundreds of ms to ~1–2 s — and you currently set no
`minInstances`, so that's real today. Removing it on functions means paying for
always-warm instances, ×4. Workers use V8 isolates: effectively **no cold start**,
running at the PoP nearest Twilio's egress. *Caveat:* both still read RTDB, and
that round-trip to the DB's region is a latency floor Workers don't remove — so
steady-state *warm* latency is comparable; the win is eliminating cold starts
**and** the cost of avoiding them. (Parallelize the two RTDB reads to shave the
data portion.)

**Cost — ~$0–5/mo.** Workers free tier: 100k requests/day and 10 ms *CPU* per
request. Critically, time spent *waiting* on the RTDB/FCM subrequests is **not**
CPU time, so these light handlers fit the free CPU cap. **$0** if volume stays
under ~100k/day (plausible: a call = 1 webhook + a few status callbacks; an SMS =
1). **$5/mo** buys Workers Paid (10M requests, higher CPU + subrequest limits) for
headroom. Either way it's flat and cheap — no per-hour always-on infrastructure —
and you also drop the webhook function invocations.

**Why Apple stays a Cloud Function.** Move to the edge what *benefits* from it;
leave Apple where it is:
- Its gate is the **JWS cert chain**, not the WAF — Cloudflare can't tell a forged
  POST from a real one, so fronting buys ~nothing.
- **Not latency-sensitive** (fire-and-forget lifecycle events; Apple retries on
  5xx), so the no-cold-start win doesn't apply.
- **Low-volume** — not a volumetric target, negligible invocation cost.
- Porting it is the **hardest, most dangerous** part: JWS chain verification + the
  App Store Server API (JWT-authed with `apple_iap_key`). The plan already uses
  `app-store-server-library`'s `SignedDataVerifier` (Node); hand-rolling chain
  verification in WebCrypto is error-prone **and** security-critical (accept a
  forged "renewed" event → free subscriptions).
- It **belongs with `subscription.ts`** (shares `apple_iap_key`, writes expiry to
  RTDB beside the Google RTDN consumer). One low-volume, JWS-gated function on
  cloudfunctions.net is an acceptable residual — it reintroduces **no** origin-lock
  need.

### What this supersedes
For the migrated Twilio webhooks, the Workers end-state makes baseline machinery
unnecessary:
- **§5.3 / §6.5 `X-Origin-Auth` header** — no separate origin to protect; the
  Worker is the edge. (Belongs only to the interim proxy approach, and is moot
  once the functions are deleted.)
- **§5.1 Origin Rule host/SNI override** — the Worker serves the hostname
  directly.
- **§6.1 dual-URL-in-one-function** — not needed: during migration the old URL →
  old function (its existing validation), the new URL → Worker (its own). Two
  parallel implementations, each correct for its own URL.
- **§6.6 `maxInstances`** — only needed on the remaining Apple function + callables.

Still required: **§5.2 WAF rules** (now in front of the Worker), **§6.3 self-heal
+ §7 tenant re-point**, **§6.4 Apple JWS**, **§6.1a fail-closed** (in the Worker).

### Migration (zero-downtime)
1. **Build + deploy the Worker** on a **Workers Custom Domain**
   `dialcrest-hooks.peblet.be` (auto-provisions the cert; see §4 on the
   first-vs-second-level-subdomain cert cost). Old functions keep serving
   `*.cloudfunctions.net` — both run in parallel.
2. **Smoke-test** the Worker with signed `curl`s (§11.9-style) and a real test
   tenant.
3. **Re-point tenants** to the Worker URL: self-heal (§6.3) for active users + the
   Phase-4 backfill script for the long tail. The script is identical either way —
   it only changes the host written into Twilio.
4. **Watch** until no traffic hits the old function webhooks (§8 host counter).
5. **Delete the four `onRequest` Twilio functions.** The raw webhook URL is gone —
   no LB, no ingress config, no origin secret for these.

Migrate path-by-path to de-risk: start with the trivial `twilioOutgoingCall` /
`twilioCallStatusChanges`, then `twilioIncomingCall`, then `twilioIncomingMessage`.

### Downsides
- **A real port, not a toggle:** signature validation, RTDB REST, FCM v1, OAuth
  minting (~a few hundred lines + `wrangler` setup + secrets).
- **Split runtime / duplicated logic** (TwiML shapes, `clientIdentity = accountSid`,
  DB paths, FCM payload, fail-closed policy in two places). Mitigation: factor the
  *pure* bits (TwiML builders, path helpers) into a shared TS module both import.
- **Observability/tests split** across Cloudflare (`wrangler tail`,
  Miniflare/vitest) and Cloud Logging/Jest.

### Cost summary
- Worker: **$0–5/mo**, flat — no per-hour infrastructure, no Google LB, no Cloud
  Armor. Versus the alternative of paying for always-warm function instances just
  to match the Worker's latency.

### Hard cost ceiling under attack
Cloudflare has **no literal "stop at €X" switch** (only billing *alerts*). But this
design gives a **true hard ceiling** that fails the service closed rather than
running up a bill — the accepted tradeoff — and for an attack specifically the
economics are already favourable:

- **Workers Free is itself the cap.** 100,000 requests/day — **account-wide**,
  shared across *all* Workers, not per-Worker — plus a ~1,000 req/min burst limit,
  reset at 00:00 UTC. Exceed either and further requests simply **fail until the
  window resets, at €0**. For four Twilio webhooks, 100k/day is large headroom, so
  you only hit it under genuine abuse. **To keep the ceiling, stay on Workers
  Free:** Workers *Paid* ($5/mo + request/CPU overage) removes the daily limit and
  therefore the hard cap — there's no native spend cap on Paid (only a self-built
  KV/Durable-Object counter returning 503 past a threshold, a soft limit whose own
  check still bills).
- **The WAF shields the budget.** WAF custom rules + rate-limiting rules (§5.2) run
  **before** the Worker and are flat-rate (included on Free/Pro; the old
  per-request-metered Rate Limiting product is deprecated). Blocked/rate-limited
  requests **never invoke the Worker**, so abuse doesn't draw down the 100k/day.
- **DDoS mitigation is unmetered on every plan.** A volumetric flood doesn't bill
  bandwidth — the "a DDoS gave me a huge egress bill" failure mode (possible
  against a raw cloud origin) doesn't apply once traffic is fronted here.

Net: an attack is absorbed by unmetered DDoS mitigation + flat-rate WAF for €0, and
anything that slips through burns the daily Worker budget and then goes dark at €0.
Zone plan stays flat (Free €0 / Pro ~€20/mo); keep metered add-ons (R2, KV/D1/DO/
Queues at scale, Images, Stream, Argo, Load Balancing, Spectrum, Bot Management)
disabled, and set Billing → Notifications as a tripwire. The GCP Functions origin —
the other variable-cost surface while webhooks still run there — is capped
separately (already configured; a GCP budget → Pub/Sub → disable-billing automation).

> Caveat: Cloudflare adjusts these free-tier daily/burst numbers periodically and
> this is written against a knowledge cutoff — confirm the current limits and WAF
> inclusions against Cloudflare's live docs before relying on exact figures.
