# AGENTS.md

Guidance for coding agents working in this repo.

## Security invariants — externally-reachable endpoints

Read docs/edge-hardening-plan.md before touching functions/src/twilio.ts,
functions/src/edge.ts, functions/src/index.ts or the Twilio-webhook Worker. These
rules must not be broken:

- **No unauthenticated public endpoint.** Every `onRequest` function (and every
  Worker route) must authenticate its payload before doing any work — Twilio
  `X-Twilio-Signature`, Apple JWS (`verifyAppleNotificationSignature`), or Pub/Sub
  IAM. Never add a public endpoint that skips it.
- **Don't reintroduce the signature fail-open.** Once `TWILIO_SIGNATURE_FAIL_CLOSED`
  is on, an `AccountSid` with no stored Auth Token must be rejected, not allowed.
  The fail-open is a one-time migration grace. Same policy in the Worker.
- **Only store an Auth Token Twilio has accepted.** `rememberAuthToken` verifies a
  changed token with an authenticated Twilio call before writing it; don't bypass
  that — the callables don't prove account ownership on their own.
- **Callables keep `enforceAppCheck: true`.** Don't remove it. App Check proves a
  genuine app, not account ownership: anything that mints a credential for an
  account (`twilioAccessToken`, incl. its unregister-only token) must run
  `verifyTwilioCredentials` first.
- **Inbound calls are entitlement-gated per device, not in the webhook.** The
  webhook can't tell devices apart (shared identity); a non-entitled device
  removes its own registration with the unregister-only token. Never add an
  account-level paid flag — one customer must not pay for the whole line.
- **Validate against the URL the endpoint is served at — never reconstruct it**
  from request headers (`Host`, `X-Forwarded-Host`, …); those are spoofable. The
  functions validate only `FUNCTIONS_BASE_URL/<path>`; the Worker only
  `https://dialcrest-hooks.peblet.be/<path>`.
- **`WEBHOOK_PUBLIC_BASE_URL` is only the host written into Twilio.** Changing it
  re-points tenants (self-heal on their next callable); it must never change what
  an endpoint validates against. Keep the old endpoint running until its traffic
  drains.
- **Don't alter the webhook body, path, or query string** anywhere (code or
  Cloudflare rules). The Twilio HMAC covers URL + sorted POST params.
- **Self-heal only touches what's ours.** Re-pointing updates our TwiML Apps and
  only those number webhooks that still point at one of our hosts, and never
  rewrites the `numbers/<sid>/original` restore snapshot.
- **Worker and functions must not drift** while both exist: TwiML shapes,
  `clientIdentity = accountSid`, RTDB paths and the FCM payload live in
  `functions/src/shared/webhooks.ts`, imported by both (`worker/` bundles it).
  Change them there; don't fork them. Keep that module dependency-free.
- **The Worker never fails open on a misconfiguration.** Only transient
  RTDB/Google errors (5xx, network) may skip the signature check; permission or
  key errors must surface as 500.
- **The Worker has no `*.workers.dev` alias** (`workers_dev = false`): the
  WAF-protected Custom Domain must be the only way in.
- **Cost ceiling**: `setGlobalOptions({ maxInstances })` in index.ts covers every
  function — don't override it upward on a public endpoint without reason.
