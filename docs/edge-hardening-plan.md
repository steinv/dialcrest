# Edge Hardening Plan — Twilio webhooks on a Cloudflare Worker

Status: **in progress** — function-side changes and Worker code done (§13); nothing deployed
Author: stein
Last updated: 2026-10-03

Harden the externally-reachable endpoints against abuse by moving the four
inbound **Twilio webhooks** off Cloud Functions onto a **Cloudflare Worker** at
`dialcrest-hooks.peblet.be`, with Cloudflare's WAF / rate limiting / bot rules in
front of it, then **deleting the functions** so no raw `*.cloudfunctions.net`
webhook URL is left to bypass the WAF. Cryptographic checks (Twilio HMAC in the
Worker, Apple JWS in the remaining function) stay the real gate. Includes a
**zero-downtime migration** for existing tenants whose Twilio numbers point at
the current `*.cloudfunctions.net` URLs.

> **Correction (2026-10-03).** An earlier draft had an interim "Tier A" that
> proxied `dialcrest-hooks.peblet.be` through Cloudflare *to the functions*
> (Origin Rule host/SNI override, `X-Origin-Auth` origin-secret header, dual-URL
> signature validation in the functions). That was a mistake:
> `dialcrest-hooks.peblet.be` is the **Worker's** hostname and never lands on
> Firebase. The interim layer is dropped — the functions only ever validate their
> own URL, and there is no origin-secret header.

---

## 1. Guiding facts from the current codebase

- **Gen2 functions** (`firebase-functions/v2`), project `twilio-phone-peblet`,
  region `europe-west1`, reachable at
  `europe-west1-twilio-phone-peblet.cloudfunctions.net/<fn>` (and a `*.run.app`
  URL). Both are public.
- **Externally-reachable, unauthenticated HTTP endpoints** (`onRequest`, no App
  Check — the abuse surface):
  | Function | Role | Guard | End-state |
  |---|---|---|---|
  | `twilioIncomingCall` | inbound PSTN voice (TwiML App `voiceUrl`) | Twilio signature | → Worker |
  | `twilioOutgoingCall` | outbound voice (TwiML App `voiceUrl`) | Twilio signature | → Worker |
  | `twilioCallStatusChanges` | voice status callback | Twilio signature | → Worker |
  | `twilioIncomingMessage` | inbound SMS/MMS (`smsUrl`) | Twilio signature | → Worker |
  | `twilioAppleNotifications` | App Store Server Notifications V2 | Apple JWS (§6.4) | stays a function |
- **All 9 `onCall` functions enforce App Check** and stay Cloud Functions; out of
  scope apart from the cost ceiling (§6.6).
- `onPlaySubscriptionNotification` is **Pub/Sub-triggered** — IAM-protected,
  nothing to do.
- **Twilio signs HMAC-SHA1 over `URL + the alphabetically-sorted POST params`**,
  base64, with the number-owning account's Auth Token. So each endpoint validates
  against the exact URL Twilio was told to call — the function against its
  `*.cloudfunctions.net` URL, the Worker against `https://dialcrest-hooks.peblet.be/...`
  — and nothing in between may alter the body, path or query string.
- **The host written into Twilio is config** (`WEBHOOK_PUBLIC_BASE_URL`, §6.2) and
  is deliberately separate from what the functions validate against
  (`FUNCTIONS_BASE_URL`, fixed). Flipping the param moves tenants; it never
  changes which URL a function accepts.
- Auth Tokens are stored by `rememberAuthToken` (on `twilioRegister` /
  `twilioAccessToken`) at `/twilio/<sid>/secret/authToken`, which both the
  functions and the Worker read for validation.

---

## 2. Goals and non-goals

1. **Prevent unauthorized calls.** Enforced at the endpoint, on every path:
   Twilio HMAC (functions now, Worker later) and Apple JWS. Requires (a) **Apple
   JWS verification** (done, §6.4), (b) **fail-closed** signature checks once
   tokens are backfilled (§6.1a) — today a made-up `AccountSid` with no stored
   token passes — and (c) **only storing Auth Tokens Twilio has accepted** (done,
   §6.1b), or fail-closed just turns token poisoning into a DoS.
2. **Block untrusted actors at the WAF.** IP/ASN/geo blocks, rate limits, bot
   rules and an edge drop of requests missing `X-Twilio-Signature`, in front of the
   Worker on `dialcrest-hooks.peblet.be`. Effective only once the raw function
   URLs are deleted (§14) — until then they remain a WAF bypass, guarded by the
   signature check and the cost ceiling.

Supporting goals: migrate existing tenants with **zero downtime** and a clean
rollback; a hard cost ceiling on both platforms.

**Non-goals**
- Fronting the `onCall` callables (App Check gates them; would need a client
  change). Covered by the cost ceiling only.
- Fronting `twilioAppleNotifications` (§14 "Why Apple stays a Cloud Function").
- Google Load Balancer / Cloud Armor / any proxy-to-functions setup.
- Edge-only authentication — Cloudflare's WAF can check signature *presence*, not
  validity; the Worker does the real HMAC check.

**Threat model.** (a) Volumetric abuse / cost-amplification against public
webhook URLs; (b) forged webhook payloads driving call/SMS routing, push
notifications or subscription state; (c) scanner/bot noise. Not in scope: a
compromised tenant Twilio account, or Google-infrastructure DoS.

---

## 3. Constraints

1. **Validation URL must equal the configured URL.** A tenant's TwiML Apps and
   numbers point at exactly one host at a time; whichever endpoint serves that
   host validates against its own URL. During migration both endpoints run in
   parallel (old URL → function, new URL → Worker), each correct for its own URL —
   no endpoint needs to accept two hosts.
2. **The raw origin stays reachable until deleted.** The WAF only protects traffic
   that goes through Cloudflare. The `*.cloudfunctions.net` webhooks stay
   reachable (signature-checked, `maxInstances`-capped) until §14 step 5 deletes
   them.

---

## 4. Target hostname

```
dialcrest-hooks.peblet.be   →  Cloudflare Worker (Workers Custom Domain), path-for-path
```

Paths are 1:1 with the old function names, e.g.
`https://dialcrest-hooks.peblet.be/twilioIncomingCall`, so `webhookUrl(path)` is
the same code for both hosts.

**Why not `hooks.dialcrest.peblet.be`.** Cloudflare's free Universal SSL covers
`peblet.be` and one wildcard level `*.peblet.be`; a second-level name needs paid
Advanced Certificate Manager (~$10/mo) — unless the Workers Custom Domain's
per-hostname cert covers it for free (verify in the dashboard). Default to the
first-level name.

---

## 5. Cloudflare

### 5.1 Hosting
The Worker is bound to `dialcrest-hooks.peblet.be` as a **Workers Custom Domain**
(auto-provisions DNS + cert). No CNAME to Google, no Origin Rule, no Transform
Rule. SSL/TLS **Full (strict)**. No rule may add query params or rewrite the
body/path on this host.

### 5.2 WAF / rate-limit rules (scoped to dialcrest-hooks.peblet.be)

Twilio paths:
`http.request.uri.path in {"/twilioIncomingCall" "/twilioOutgoingCall" "/twilioCallStatusChanges" "/twilioIncomingMessage"}`

- **Require the signature header**: block if
  `not any(http.request.headers["x-twilio-signature"][*] ne "")`.
- **Method**: block non-`POST`.
- **Block everything else** on the host (any path not in the set above).
- **Rate limiting**: a generous per-IP limit (Twilio egresses from a bounded IP
  set, so a tight one throttles legit traffic) plus a stricter global per-path
  ceiling. Per-`AccountSid` body-field limits need Business+. Rules run before the
  Worker and are flat-rate, so blocked abuse never invokes it — this is what
  shields the Workers-Free daily budget (§14 "Hard cost ceiling").
- **Bots**: block, never JS/managed challenge — Twilio can't solve challenges.
  Exclude this host from (Super) Bot Fight Mode; Security Level low.
- **Optional IP allowlist** of Twilio's published ranges — opt-in, needs a
  maintenance owner; Twilio recommends signature validation instead.

---

## 6. Code changes (functions/)

### 6.1a Fail-closed signature check — **done (flag off)**
`isValidTwilioSignature` skips the check (grace period) for an `AccountSid` with
no stored token. `TWILIO_SIGNATURE_FAIL_CLOSED=true` makes that a rejection. Every
tokenless webhook logs `event: twilio_webhook_tokenless` with `knownTenant`
(whether `/twilio/<sid>/createdAt` exists), so the flip can be timed (§8). An RTDB
*read error* stays fail-open regardless — outsiders can't induce it, and an
outage shouldn't drop calls. Changing the param is an `.env` edit + redeploy.
The Worker implements the same policy.

### 6.1b Only store Auth Tokens Twilio accepted — **done**
`twilioAccessToken` can succeed entirely from cached state (API key, TwiML App,
push credential) without ever presenting the caller's `authToken` to Twilio, yet
it called `rememberAuthToken` — so any App-Check-passing caller could overwrite
another tenant's stored token (forge its webhooks, e.g. push fake SMS
notifications to its devices; or, once fail-closed, black-hole its calls).
`rememberAuthToken` now verifies a *changed* token with an authenticated
`accounts(sid).fetch()` before writing; an unchanged token costs no round-trip.

### 6.2 Config-driven webhook host — **done**
`functions/src/edge.ts`:
- `WEBHOOK_PUBLIC_BASE_URL` — the host **written into** Twilio. Defaults to the
  functions host; set to `https://dialcrest-hooks.peblet.be` at cutover
  (`functions/.env.twilio-phone-peblet`).
- `FUNCTIONS_BASE_URL` — fixed; the only URL the functions validate against.
- `isKnownWebhookUrl` — recognizes our webhook on any host we've used, so
  re-pointing and restoring work on both sides of the cutover.

### 6.3 Self-heal existing Twilio config — **done**
`ensureWebhooksCurrent(accountSid, authToken)` runs from `twilioAccessToken`,
`twilioGetIncomingAppSid` and (first) `twilioConfigureNumbers`:
- Marker `/twilio/<sid>/webhook-base-url` = the base URL last applied. Current →
  one RTDB read, done. Storing the URL (not a version number) means rolling the
  param back re-points tenants back automatically.
- Stale → update the cached outgoing/incoming TwiML Apps' `voiceUrl`; on numbers
  whose `voiceApplicationSid` is our incoming app, update `statusCallback` /
  `smsUrl` **only where they still point at one of our hosts**; then set the
  marker. A deleted app (20404) just drops its cache. Any other failure is logged,
  swallowed, and retried next call (marker not advanced).
- Uses the live credentials the callable carries; never touches the restore
  snapshot.
- Related fixes: `getOrCreateTwimlApp` corrects the `voiceUrl` of an app it finds
  by name; `configureSelectedNumbers` re-points a selected number on an old host
  and still restores a deselected one.

### 6.4 Apple JWS verification — **done**
`verifyAppleNotificationSignature` (`subscription.ts`) uses
`@apple/app-store-server-library`'s `SignedDataVerifier` against the bundled
**Apple Root CA - G3** (`functions/certs/`, SHA-256 `63:34:3A:BF:…:91:79`), with
online checks (OCSP, current date). Checks chain, signature, `bundleId`, and
`appAppleId` + environment. Forged → **401**; unreachable OCSP → **500** (Apple
redelivers). Sandbox and Production verifiers are both tried (same URL receives
both).
**Needs config:** add `appAppleId` (App Store Connect → App Information → Apple
ID, a number) to `apple_iap_key` in `TWILIO_PEBLET_SECRET`; until then
**Production notifications are rejected** (logged), Sandbox ones verify.

### 6.6 Cost ceiling — **done**
`setGlobalOptions({ maxInstances: 10 })` in `index.ts` covers every function.
`minInstances` stays 0.

### 6.7 Tests — **done**
`twilio.test.ts`: function validates only its own URL (Worker-URL and cross-path
signatures rejected), fail-closed on/off, token verified before storage,
self-heal (re-point, foreign webhooks untouched, snapshot untouched, 20404,
failure → retry, rollback), configure/restore across the host change, app found
by name gets corrected. `index.test.ts`: Apple JWS genuine / unsigned / altered /
wrong bundle / Production without and with `appAppleId`; self-heal wiring.
Apple fixtures use a throwaway PKI with Apple's marker OIDs
(`src/testUtils/appleTestPki.ts`). `jest.config.js` now loads `slowBufferShim`
in `setupFiles` (fixes an order-dependent suite failure on Node 24+).

---

## 7. Migration — zero-downtime, phased

**Phase 1 — Deploy the function-side changes** (§6, done in code). Purely
additive: `WEBHOOK_PUBLIC_BASE_URL` still = functions host, fail-closed off.
Before deploying, set `appAppleId` in the secret (§6.4).

**Phase 2 — Build the Worker** (§14) and stand up `dialcrest-hooks.peblet.be`
with the WAF rules (§11). Nobody points at it yet → zero tenant risk. Smoke-test
with signed `curl`s and a test tenant (§11.4).

**Phase 3 — Cut over.** Set `WEBHOOK_PUBLIC_BASE_URL=https://dialcrest-hooks.peblet.be`
and redeploy. New TwiML Apps/numbers get the Worker URL; existing tenants
self-heal on their next callable. Not-yet-migrated tenants keep working on the
functions.

**Phase 4 — Backfill the long tail.** An admin script iterates tenants and runs
the §6.3 re-point using the stored token, for tenants who haven't opened the app.

**Phase 5 — Fail-closed.** When `twilio_webhook_tokenless` from known tenants is ≈
0, set `TWILIO_SIGNATURE_FAIL_CLOSED=true` (functions and Worker).

**Phase 6 — Delete the four Twilio `onRequest` functions** once their invocation
count is ≈ 0 for N days. The raw webhook origin is gone.

---

## 8. Observability and exit criteria

- **Traffic still on the functions** = invocations of the four Twilio functions
  (Cloud Monitoring per function). → 0 means Phase 6 is safe.
- **Tokenless webhooks**: `jsonPayload.event="twilio_webhook_tokenless"`, split by
  `knownTenant`. Known ≈ 0 → Phase 5 is safe; unknown is the junk it will reject.
- **Self-heal**: "Re-pointed … webhooks" / "Failed to re-point" log lines.
- **Apple**: "Apple notification failed signature verification" warnings.
- **Cloudflare analytics**: blocked / rate-limited counts per rule; watch for
  false positives on Twilio IPs.

---

## 9. Rollback

- **Phase 1** is additive.
- **Worker misbehaving:** revert `WEBHOOK_PUBLIC_BASE_URL` to the functions host
  and redeploy; tenants self-heal back on their next callable (the marker
  compares against the URL), and the functions still validate their own URL. Only
  possible while the functions exist — don't do Phase 6 until the Worker has been
  stable for a while.
- **WAF too aggressive:** loosen or disable the specific rule.
- **Fail-closed rejecting real traffic:** set the flag back to `false`.

---

## 10. Open decisions / cost

- **Path-by-path cutover** (§14) would need a per-path override of
  `WEBHOOK_PUBLIC_BASE_URL`; currently one switch moves all four. Add only if
  wanted.
- **Hostname cert** (§4).
- **Cloudflare plan**: basic rules work on Free/Pro; per-`AccountSid` rate limits
  need Business+.
- **IP allowlisting** Twilio ranges — opt-in.
- Worker's service-account key rotation cadence (procedure in worker/README.md).

---

## 11. Manual runbook

### 11.1 Before deploying Phase 1
1. Add `appAppleId` to `apple_iap_key` and re-set the secret:
   ```bash
   firebase functions:secrets:set TWILIO_PEBLET_SECRET   # paste JSON incl. "apple_iap_key": {..., "appAppleId": <number>}
   ```
2. `firebase deploy --only functions`.

### 11.2 Cloudflare (Phase 2)
3. Create the Worker's service account + secret and deploy it (`worker/README.md`
   "One-time setup"); `wrangler.toml` binds the Custom Domain
   `dialcrest-hooks.peblet.be`.
4. **SSL/TLS → Full (strict).**
5. **Security → WAF → Custom rules** — block bad webhook shape:
   ```
   (http.host eq "dialcrest-hooks.peblet.be"
    and (not http.request.uri.path in {"/twilioIncomingCall" "/twilioOutgoingCall" "/twilioCallStatusChanges" "/twilioIncomingMessage"}
         or http.request.method ne "POST"
         or not any(http.request.headers["x-twilio-signature"][*] != "")))
   ```
   Action **Block**.
6. **Security → WAF → Rate limiting rules**: per-IP (start ~100 req / 10 s,
   action Block) + a stricter global per-path rule.
7. **Bots / Security Level**: no challenges on this host (Skip rule for Super Bot
   Fight Mode if needed; Configuration Rule → Security Level low).
8. **Billing → Notifications** as a tripwire; keep metered add-ons off.

### 11.3 Google Cloud
9. Cost ceiling is in code (§6.6). Webhook invoker stays `allUsers` (Twilio and
   Apple can't present Google IAM tokens).

### 11.4 Verify before Phase 3
10. Signed request to the Worker (sign with a test tenant's token: HMAC-SHA1 over
    URL + sorted params, base64) → 200 + TwiML:
    ```bash
    curl -i -X POST https://dialcrest-hooks.peblet.be/twilioIncomingCall \
      -H 'X-Twilio-Signature: <computed>' \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data 'AccountSid=AC...&From=%2B32...&To=%2B32...'
    ```
11. Same without the signature header → Cloudflare 403, no Worker invocation.

### 11.5 Apple (optional)
12. ASSN URLs stay on
    `https://europe-west1-twilio-phone-peblet.cloudfunctions.net/twilioAppleNotifications`
    (Production **and** Sandbox) — Apple is not moved.

---

## 12. AGENTS.md guardrails

`AGENTS.md` at the repo root (with a one-line `CLAUDE.md` pointing at it) holds
the security invariants derived from this plan.

---

## 13. Checklist

**Functions (Phase 1)**
- [x] 6.1a Fail-closed behind `TWILIO_SIGNATURE_FAIL_CLOSED` (default off) + tokenless logging
- [x] 6.1b Verify Auth Token with Twilio before storing it
- [x] 6.2 `WEBHOOK_PUBLIC_BASE_URL` (edge.ts)
- [x] 6.3 Self-heal on callables (+ `webhook-base-url` marker)
- [x] 6.4 Apple JWS verification + README/SUBSCRIPTION_NOTIFICATIONS reconcile
- [x] 6.6 `maxInstances` (global)
- [x] 6.7 Tests
- [x] 12 `AGENTS.md` + `CLAUDE.md`
- [ ] Set `appAppleId` in `TWILIO_PEBLET_SECRET`; deploy Phase 1

**Worker (Phases 2–6)**
- [x] Worker project (`worker/`, see its README) + `wrangler.toml` (Custom Domain, no workers.dev)
- [x] Port signature validation (WebCrypto HMAC-SHA1, parity-tested against twilio-node; fail-closed flag) + RTDB-REST + FCM-v1 helpers
- [x] Shared TS module for the pure bits (`functions/src/shared/webhooks.ts`: TwiML builders, DB paths, push payload), used by both
- [ ] Dedicated service account (RTDB Admin + FCM Admin) → `GOOGLE_SERVICE_ACCOUNT_JSON` Worker secret (worker/README.md)
- [ ] Deploy; WAF + rate-limit rules (§11.2)
- [ ] Smoke-test (§11.4)
- [ ] **Phase 3**: flip `WEBHOOK_PUBLIC_BASE_URL`; confirm self-heal on a test tenant
- [ ] **Phase 4**: backfill script for the long tail
- [ ] **Phase 5**: `TWILIO_SIGNATURE_FAIL_CLOSED=true`
- [ ] **Phase 6**: delete the four Twilio `onRequest` functions; update README URLs

---

## 14. The Worker

The four Twilio webhooks move to a Cloudflare Worker on
`dialcrest-hooks.peblet.be`; once tenants are migrated the `onRequest` functions
are **deleted**, so there's no raw webhook URL left to bypass the WAF. No Google
Load Balancer, no Cloud Armor, no origin secret.

**Scope:** Twilio ×4 → Worker. `twilioAppleNotifications` and the callables stay
Cloud Functions.

### What the Worker does
| Endpoint | Logic | Deps in the Worker |
|---|---|---|
| `twilioOutgoingCall` | `To`/`From` → TwiML `<Dial callerId>` | 1 RTDB read (token for sig) |
| `twilioIncomingCall` | read `trial/expiresAt` → TwiML `<Dial><Client>` | 2 RTDB reads |
| `twilioCallStatusChanges` | log / record | 1 RTDB read |
| `twilioIncomingMessage` | read `messaging-tokens` → **data-only FCM fan-out** | 2 RTDB reads + N FCM sends |

Hand-rolled (no `firebase-admin` in Workers):
- **Twilio signature validation** — WebCrypto HMAC-SHA1 over
  `URL + alphabetically-sorted POST params`, base64, constant-time compare,
  against `https://dialcrest-hooks.peblet.be/<path>`. Same fail-closed policy as
  §6.1a.
- **Firebase via REST** — mint a Google OAuth token (RS256 service-account JWT via
  WebCrypto, cached ~1 h), then RTDB REST for the stored token / trial expiry /
  messaging tokens and FCM HTTP v1 for the SMS fan-out. SA key in
  a `wrangler` secret — a dedicated least-privilege service account, not
  `android_fcm` (worker/README.md).

A token read that fails *transiently* (5xx/network) fails open like the
functions; a permission or key error returns 500 instead — otherwise a revoked
key would silently disable authentication.

The Worker calls no Twilio REST API. Token storage is unchanged: the callables
keep writing `/twilio/<sid>/secret/authToken`; the Worker reads it.

### Why it's worth it
**Voice latency — no cold starts.** Incoming/outgoing call webhooks are in the
call path (Twilio waits for TwiML). Gen2 functions cold-start in hundreds of ms
to ~1–2 s with no `minInstances`; Workers (V8 isolates) effectively don't. The
RTDB round-trip remains a latency floor either way — parallelize the reads.

**Cost — ~$0–5/mo.** Workers Free: 100k requests/day, 10 ms CPU per request
(waiting on subrequests isn't CPU). Workers Paid $5/mo for headroom — but see the
cost ceiling below.

### Why Apple stays a Cloud Function
- Its gate is the JWS chain (§6.4), not the WAF — fronting buys ~nothing.
- Not latency-sensitive; low volume.
- Porting JWS chain verification + the App Store Server API to WebCrypto is the
  hardest and most security-critical part (accepting a forged "renewed" event →
  free subscriptions).
- It belongs with `subscription.ts` (shares `apple_iap_key`, writes beside the
  Google RTDN consumer).

### Migration (zero-downtime)
1. Build + deploy the Worker on the Custom Domain. Functions keep serving
   `*.cloudfunctions.net`; both run in parallel, each validating its own URL.
2. Smoke-test (§11.4) with a real test tenant.
3. Flip `WEBHOOK_PUBLIC_BASE_URL`; self-heal + Phase-4 backfill re-point tenants.
4. Watch until the four functions see no traffic (§8).
5. Delete them.

### Downsides
- A real port (~a few hundred lines + `wrangler` + secrets).
- Duplicated logic (TwiML shapes, `clientIdentity = accountSid`, DB paths, FCM
  payload, fail-closed policy) until the functions are deleted — factor the pure
  bits into a shared module.
- Observability/tests split across Cloudflare and Cloud Logging/Jest.

### Hard cost ceiling under attack
- **Workers Free is itself the cap**: 100k requests/day account-wide plus a burst
  limit; beyond it requests fail at €0 until the daily reset. Workers Paid removes
  that cap (no native spend cap), so stay on Free to keep it.
- **WAF rules run before the Worker** and are flat-rate, so blocked abuse doesn't
  consume the daily budget.
- **DDoS mitigation is unmetered.**
- The GCP side is capped by `maxInstances` (§6.6) plus the existing GCP budget →
  Pub/Sub → disable-billing automation.

> Cloudflare adjusts free-tier limits periodically — confirm against the live
> docs before relying on exact figures.
