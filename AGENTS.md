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
- **Callables keep `enforceAppCheck: true`.** Don't remove it.
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
  `clientIdentity = accountSid`, RTDB paths and the FCM payload stay identical.
  Keep the pure bits in a shared module; don't fork them.
- **Cost ceiling**: `setGlobalOptions({ maxInstances })` in index.ts covers every
  function — don't override it upward on a public endpoint without reason.
