# Apple subscription work — parked (needs Apple Developer account)

Tracks the Apple-specific work that's outstanding for the subscription rework
(branch `rework-license`). Parked because there's no Apple Developer account
available right now.

The **backend code for Apple already exists and compiles** — the items below are
console setup, a secret, and sandbox testing. Nothing here blocks
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
{ "issuerId": "...", "keyId": "...", "privateKey": "<PEM>", "bundleId": "...", "appAppleId": 1234567890 }
```

Generate the key in App Store Connect → Users and Access → Integrations → keys,
then `firebase functions:secrets:set TWILIO_PEBLET_SECRET` (see the header of
`functions/src/index.ts`). Verification (`verifyApplePurchase`) needs this too,
so nothing Apple-side works until it's set. `appAppleId` is the app's numeric
Apple ID (App Store Connect → App Information → Apple ID); without it, Production
App Store Server Notifications **and Production purchases presented by the app**
fail signature verification and are rejected.

## 3. ~~Hardening: verify the Apple notification JWS signature~~ (done)

`twilioAppleNotifications` now verifies the `x5c` chain with
`@apple/app-store-server-library`'s `SignedDataVerifier` against the bundled
Apple Root CA - G3 (`functions/certs/`) before processing — see
`verifyAppleNotificationSignature` in `functions/src/subscription.ts` and
docs/edge-hardening-plan.md §6.4. Only needs `appAppleId` set (section 2) and a
real Sandbox notification to confirm end to end.

## 4. ~~UX: iOS auto-recover paid entitlement after reinstall~~ (done, untested)

With StoreKit 2 (see §5), `in_app_purchase_storekit`'s `restorePurchases()`
iterates `Transaction.currentEntitlements` — no sign-in prompt (the prompting
`AppStore.sync()` is a separate call we never make). So `SubscriptionService`
now runs the startup restore and the on-block `recoverEntitlement()` retry on
**both** platforms, and a reinstalled iOS subscriber passes the enforcement
gate on their first dial without tapping "Restore purchases".

Still to confirm on a device (§6): a reinstall recovers the entitlement
silently, and the startup restore doesn't prompt.

## 5. ~~Correctness: client-presented entitlement must be a JWS~~ (done, untested)

The backend only accepts a StoreKit 2 transaction JWS
(`verifyPresentedAppleTransaction`: Apple chain, signature, bundle id,
environment); a StoreKit 1 base64 app receipt is rejected. Production
transactions also need `appAppleId` (section 2).

`in_app_purchase_storekit` has defaulted to **StoreKit 2** since 0.4.0 (the
lockfile has 0.4.13), so `serverVerificationData` is already the transaction's
`jwsRepresentation` — the earlier "defaults to StoreKit 1" premise was out of
date. Changes made:
- `ios/Podfile` platform raised 13.0 → **15.0** (StoreKit 2's minimum). The
  Xcode project isn't checked in — when it's (re)generated, set the Runner
  target's `IPHONEOS_DEPLOYMENT_TARGET` to 15.0 too.
- `SubscriptionService._verifyPurchase` refuses (throws) an iOS purchase whose
  verification data isn't a 3-segment JWS, so a StoreKit 1 fallback fails
  loudly instead of persisting a token every gated call would reject.

Still to do: a sandbox test that a real device-issued entitlement verifies (§6).

## 6. Testing (needs the account + a sandbox tester)

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
- `lib/services/subscription_service.dart` — startup restore, `recoverEntitlement`, `_verifyPurchase`
