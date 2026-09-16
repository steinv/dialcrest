# Apple subscription work — parked (needs Apple Developer account)

Tracks the Apple-specific work that's outstanding for the subscription rework
(branch `rework-license`). Parked because there's no Apple Developer account
available right now. The general design and the Android/Google side are in
[`SUBSCRIPTION_NOTIFICATIONS.md`](SUBSCRIPTION_NOTIFICATIONS.md); this file is
just the Apple to-do list so it isn't lost.

The **backend code for Apple already exists and compiles** — the items below are
console setup, a secret, and two hardening/UX follow-ups. Nothing here blocks
the Android path from working.

## 1. App Store Connect console setup (needs the account)

- **App Store Server Notifications V2** — set the **Production URL** and the
  **Sandbox URL** to the deployed webhook:
  `https://europe-west1-twilio-phone-peblet.cloudfunctions.net/twilioAppleNotifications`
  (App Store Connect → app → App Information → App Store Server Notifications,
  Version 2). The Sandbox stream is what makes fast-renewing test licenses
  update without opening the app — i.e. it fixes the originally reported bug on
  iOS.
- **Products** — confirm `monthly-dialcrest-license` / `yearly-dialcrest-license`
  have **no free-trial introductory offer** (the trial is app-side, per Twilio
  account — see the two-axis decision in the runbook).

## 2. `apple_iap_key` secret (needs the account)

The App Store Server API calls (verification + notification re-fetch) need an
App Store Connect API key with the right access, stored as `apple_iap_key`
inside `TWILIO_PEBLET_SECRET`:

```json
{ "issuerId": "...", "keyId": "...", "privateKey": "<PEM>", "bundleId": "..." }
```

Generate the key in App Store Connect → Users and Access → Integrations → keys,
then `firebase functions:secrets:set TWILIO_PEBLET_SECRET` (see the header of
`functions/src/index.ts`). Verification (`verifyApplePurchase`) needs this too,
so nothing Apple-side works until it's set.

## 3. Hardening: verify the Apple notification JWS signature (code TODO)

`twilioAppleNotifications` (`functions/src/index.ts`) →
`handleAppleNotification` (`functions/src/subscription.ts`) currently uses the
**re-fetch-from-Apple trust model**: it decodes the notification only to read
the `originalTransactionId`, then re-queries authoritative state from Apple. A
forged notification therefore can't inject subscription state — the remaining
gap is edge spam/DoS.

To close it:
- Add Apple's official `app-store-server-library` (npm) and use its
  `SignedDataVerifier` to verify the `x5c` chain before processing.
- It needs Apple's root CA certs (Apple Root CA - G3, etc.) bundled with the
  function — download from https://www.apple.com/certificateauthority/.
- Do **not** hand-roll a fingerprint check from memory; use the library or
  bundle the real certs.

## 4. UX: iOS auto-recover paid entitlement after reinstall (code TODO)

Marked `TODO(ios)` in `lib/services/subscription_service.dart` (the
`currentEntitlement` getter). On iOS, StoreKit 2's
`Transaction.currentEntitlements` can recover a paid subscription after a
reinstall **without** a sign-in prompt, unlike `restorePurchases()`.

**Android is done** — `SubscriptionService` now calls `restorePurchases()`
(a silent local query on Android) at startup, and `recoverEntitlement()` retries
it silently when a dial is blocked as `subscription-expired`
(`TwilioService._accessToken`). So an Android device that owns a subscription but
hasn't cached it passes the enforcement gate on its first dial, before opening
Settings.

**iOS half to do:** give `recoverEntitlement()` / the startup path an iOS branch
that reads StoreKit 2 `Transaction.currentEntitlements` (prompt-free) and
persists the entitlement, mirroring the Android behavior. Until then:
- iOS startup does **not** auto-restore (the plugin's `restorePurchases()` can
  prompt), and `recoverEntitlement()` returns only what's already cached without
  restoring — so the on-block dial retry is a no-op on iOS.
- A reinstalled iOS subscriber must tap the "Restore purchases" button in
  Settings (which may prompt for sign-in) before dialing works.

This closes the "dials before opening Settings" gap on iOS, matching Android.

## 5. Testing (needs the account + a sandbox tester)

- Sandbox subscription renews every ~5 min, ~6 times, then stops.
- Confirm `twilioAppleNotifications` receives `DID_RENEW` and the store-keyed
  `/subscriptions/apple/{originalTransactionId}` record's `expiresAt` advances
  **without placing a call**; reopen Settings → shows active.
- Confirm a purchase, an expiry after the renewals stop, and that the OR gate
  (trial vs. paid) behaves per the runbook's testing section.

## Relevant code (already in place)

- `functions/src/index.ts` — `twilioAppleNotifications`, `twilioVerifyApplePurchase`
- `functions/src/subscription.ts` — `handleAppleNotification`,
  `refreshAppleByOriginalTransactionId`, `verifyApplePurchase`,
  `signAppleServerJwt`, `decodeAppleSignedPayload`,
  `extractAppleSubscriptionState`
- `lib/services/subscription_service.dart` — `TODO(ios)` on `currentEntitlement`
