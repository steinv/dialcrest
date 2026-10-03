# dialcrest-hooks — Twilio webhooks on Cloudflare Workers

Serves the four Twilio webhooks on `https://dialcrest-hooks.peblet.be/<path>`,
replacing the Cloud Functions of the same names (design and migration:
[docs/edge-hardening-plan.md](../docs/edge-hardening-plan.md) §14):

| Path | Does |
|---|---|
| `/twilioIncomingCall` | TwiML ringing the tenant's app (not entitlement-gated) |
| `/twilioOutgoingCall` | TwiML dialing `To` with `From` as caller id |
| `/twilioCallStatusChanges` | logs the status callback, 202 |
| `/twilioIncomingMessage` | data-only FCM push to the tenant's devices, empty MessagingResponse |

Every request is authenticated with `X-Twilio-Signature` against the tenant's
Auth Token from RTDB (`/twilio/<sid>/secret/authToken`, written by the
callables), validated against `PUBLIC_BASE_URL/<path>` — never the request's
Host. Same fail-closed policy as the functions (`TWILIO_SIGNATURE_FAIL_CLOSED`).

TwiML, RTDB paths and the push payload come from
[`functions/src/shared/webhooks.ts`](../functions/src/shared/webhooks.ts), which
the functions use too — change behavior there, not here, so the two can't drift.

## Layout

- `src/index.ts` — routing, authentication, the four handlers
- `src/twilioSignature.ts` — WebCrypto port of twilio-node's `validateRequest`
- `src/google.ts` — service-account OAuth token (RS256 JWT via WebCrypto), cached per isolate
- `src/firebase.ts` — RTDB REST + FCM HTTP v1

## Develop

```bash
npm install
npm test            # vitest (signature parity is checked against functions/node_modules/twilio)
npm run typecheck
npm run dev         # wrangler dev — needs a .dev.vars with GOOGLE_SERVICE_ACCOUNT_JSON='<json>'
```

`npm test` needs `functions/node_modules` installed (it uses twilio-node as the
reference implementation).

## One-time setup

1. **Service account** (Google Cloud console → IAM → Service accounts, project
   `twilio-phone-peblet`). Create a dedicated one, e.g. `dialcrest-hooks-worker`,
   with only:
   - **Firebase Realtime Database Admin** (`roles/firebasedatabase.admin`) — reads
     Auth Tokens / trial expiry / messaging tokens, deletes unregistered tokens.
     Note OAuth access to RTDB bypasses `database.rules.json`.
   - **Firebase Cloud Messaging API Admin** (`roles/firebasecloudmessaging.admin`).

   Create a JSON key for it. (Don't reuse `android_fcm`: it also carries Play
   financial-data access, and this key lives outside Google.)
2. **Secret:**
   ```bash
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < key.json && rm key.json
   ```
3. **Deploy:** `npm run deploy`. `wrangler.toml` binds the Custom Domain
   `dialcrest-hooks.peblet.be` (Cloudflare creates the DNS record and cert) and
   disables `*.workers.dev`, so the WAF-protected hostname is the only way in.
4. **WAF / rate limiting / bots** for the hostname — docs/edge-hardening-plan.md §11.2.
5. **Smoke-test** with a signed request (§11.4), then cut tenants over by setting
   `WEBHOOK_PUBLIC_BASE_URL=https://dialcrest-hooks.peblet.be` in
   `functions/.env.twilio-phone-peblet` and deploying the functions.

## Operate

- Logs: `npm run tail`, or Workers Logs in the dashboard (`observability` is on).
  Events: `twilio_webhook_rejected`, `twilio_webhook_tokenless`,
  `twilio_webhook_token_read_failed`, `fcm_send_failed`, `webhook_error`.
- Fail-closed: set `TWILIO_SIGNATURE_FAIL_CLOSED = "true"` in `wrangler.toml`
  (and the functions' param) and deploy.
- A token read that fails *transiently* (5xx, network) lets the webhook through,
  like the functions; a permission/key error returns 500 instead of failing open.
- Rotating the key: create a new key, `wrangler secret put` it, delete the old key.
