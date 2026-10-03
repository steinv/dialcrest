# Subscriptions: store-account paid + per-line trial, with store notifications

This is the plan and runbook for reworking how Dialcrest tracks subscriptions.
It covers the target model, the store-console setup you have to do by hand, the
code changes, the real-time notification wiring, migration, and how to test it
in sandbox.

Read this top to bottom once before starting — the "Semantics" section is the
decision everything else follows from.

## Implementation status (branch `rework-license`)

Done:
- **Part 2** — two-axis backend: trial stays per-`accountSid`
  (`/twilio/{accountSid}/trial`), paid records moved to store-keyed
  `/subscriptions/{apple|google}/{id}`, `isSubscriptionActive` rewritten as the
  OR gate, plus a `twilioRefreshSubscription` callable for Settings.
- **Part 4** — app persists the paid entitlement per device
  (`StorageService.paidEntitlement*`), attaches it to `twilioAccessToken` via an
  injected provider, refreshes paid status in Settings so it self-heals, treats
  "already subscribed" as a re-verify instead of an error, and adds a "Restore
  purchases" button (with l10n).
- **Part 3 Apple** — `twilioAppleNotifications` `onRequest` webhook +
  `handleAppleNotification`.
- **Part 3 Google** — `onPlaySubscriptionNotification` Pub/Sub consumer +
  `handleGoogleNotification`. Requires the Play Console RTDN topic + IAM grant
  from Part 1 to be set up (topic `play-subscription-notifications`).

Pending:
- **All Apple-side work is parked** (no Apple Developer account yet) and tracked
  in [`APPLE_TODO.md`](APPLE_TODO.md): App Store Connect notification URLs, the
  `apple_iap_key` secret (incl. `appAppleId`), iOS
  `currentEntitlements` auto-recover, and sandbox testing. The Apple backend
  code is written and compiles; it just can't be exercised without the account.
- **Part 5** — migration of any existing per-`accountSid` paid records.

## Why we're changing it

Today all subscription state lives in a single record at
`/twilio/{accountSid}/subscription`, keyed only by the Twilio account. The app
authenticates to the backend with `accountSid` + `authToken` and nothing else —
there is no per-user or per-device identity. Two problems fall out of that:

1. **Collisions.** If two different store accounts (two people, or one person on
   two Apple/Google accounts) subscribe under the same `accountSid`, the second
   `verifyApple/GooglePurchase` overwrites the first in the single slot
   (`upsertSubscription`, `functions/src/subscription.ts`). One payer is
   orphaned; if the *stored* subscription later lapses, `isSubscriptionActive`
   re-verifies the wrong token and can lock out someone who is still paying.
2. **Stale display / no renewal signal.** The Settings screen reads `expiresAt`
   straight from RTDB (`SubscriptionService.fetchStatus`) and never re-verifies.
   Nothing pushes store renewals into RTDB — only a *call* (which runs
   `isSubscriptionActive`) refreshes it. So a renewed subscription shows as
   "expired" in Settings, and the purchase button then fails with "you're
   already subscribed" because the store did renew.

## Semantics (decided)

Two independent axes:

- **Trial axis — keyed on `accountSid`.** Auto-started on registration, no store
  interaction, zero friction. A trial is a **per-line grant**: everyone who
  shares a Twilio account shares one trial. Unchanged from today.
- **Paid axis — keyed on the store identity** (Apple `originalTransactionId` /
  Google purchase-token chain). A paid subscription belongs to the **person**
  (their Apple ID / Google account), not the line.

Consequences we explicitly want:

1. **A paid subscriber can use the app on *any* Twilio line.** Enforcement
   checks the entitlement the device presents, independent of `accountSid`.
2. **The trial is shared per line.** After it lapses, each person on a shared
   line needs their own paid subscription.
3. **Trial abuse surface is unchanged.** A brand-new Twilio account gets a fresh
   trial; reinstalling on the same account does not (the record persists
   server-side). No new device/user identity system is introduced.
4. **No store free-trial offer.** The trial is the app's, not the store's — so
   the paid products are configured *without* an introductory free-trial offer.

Enforcement is an OR gate:

```
active = trialActive(accountSid)                      // cheap cached read, no store round-trip
      OR verifyStoreEntitlement(presentedTxn).active  // source of truth, self-heals renewals
```

Check the trial first; only hit the store API when the trial has lapsed. During
the trial the app has no entitlement to present, so a trialing user never
touches the store.

---

## Part 1 — Store console setup (manual; must be done first)

These are dashboard steps that cannot be done from code. Do them before
deploying the notification handlers, or the handlers have nothing to receive.

### App Store Connect (Apple)

1. **Products** — the two subscription products already exist
   (`monthly-dialcrest-license`, `yearly-dialcrest-license`). Confirm they have
   **no free-trial introductory offer** (the trial is app-side). Paid intro
   offers / promo offers are fine if you want them later, but not required.
2. **App Store Server Notifications V2**
   - App Store Connect → your app → **App Information → App Store Server
     Notifications**.
   - Set **Version 2** notifications.
   - **Production URL** and **Sandbox URL** both point at the new function
     (see Part 3):
     `https://europe-west1-twilio-phone-peblet.cloudfunctions.net/twilioAppleNotifications`
   - They can be the same URL; the signed payload says which environment it is.
   - Sandbox notifications start flowing immediately — this is what makes the
     5-minute test-license renewals show up without placing a call.
3. No new secret needed — `apple_iap_key` in `TWILIO_PEBLET_SECRET` already
   authenticates the App Store Server API and is what we verify notification
   signatures against Apple's roots with.

### Google Play Console

1. **Products** — the `dialcrest` product with `monthly-dialcrest-license` /
   `yearly-dialcrest-license` base plans already exists. Confirm the base plans
   have **no free-trial offer phase**.
2. **Pub/Sub topic** (in the GCP project `twilio-phone-peblet`)
   - Create a topic, e.g. `play-subscription-notifications`.
   - Grant Google Play's publisher service account the **Pub/Sub Publisher**
     role on that topic:
     `google-play-developer-notifications@system.gserviceaccount.com`.
3. **Real-time developer notifications**
   - Play Console → **Monetization setup → Real-time developer notifications**.
   - Paste the full topic name
     (`projects/twilio-phone-peblet/topics/play-subscription-notifications`)
     and enable.
   - Use **Send test notification** to confirm wiring once the function is
     deployed.
4. No new secret — `android_fcm` already has "View financial data" in Play
   Console and is used as the Play Developer API service account.

---

## Part 2 — Backend: re-anchor the records

File: `functions/src/subscription.ts` (plus `functions/src/index.ts` wiring).

### Trial axis (mostly unchanged)

- Keep `ensureTrialStarted` and its call from `twilioRegister`
  (`functions/src/index.ts`). It's keyed at `/twilio/{accountSid}/trial`
  (renamed from `subscription` for clarity — the node holds only trial state;
  paid state lives under the store-keyed `/subscriptions/{apple|google}/{id}`).
- The trial record only needs `plan: 'trial'`, `trialStartedAt`, `expiresAt`.
  Drop the store fields from the trial record — they now live on the paid axis.

### Paid axis (new location)

- Store paid records keyed by store identity, not `accountSid`:
  - Apple: `/subscriptions/apple/{originalTransactionId}`
  - Google: `/subscriptions/google/{purchaseTokenChainRoot}`
    - Google renews the `purchaseToken` (via `linkedPurchaseToken`); key by the
      chain root so renewals update the same record. `subscriptionsv2.get`
      returns `linkedPurchaseToken` — follow it to the root on first store, or
      store both the current token and the root.
- Record shape (paid): `plan` (`monthly`/`yearly`), `expiresAt`, `autoRenew`,
  `store`, `productId`, the store id(s), `lastVerifiedAt`. This *is* the primary
  record — no separate reverse index is needed, because notifications arrive
  keyed by exactly these identifiers.
- `verifyApplePurchase` / `verifyGooglePurchase` write here. Their existing
  `refreshApple/GoogleSubscription` logic (fetch fresh state, acknowledge,
  persist) is reused almost verbatim — only the write path/key changes.

### Enforcement: the OR gate

- Rewrite `isSubscriptionActive` (currently `(accountSid, config) -> bool`) to
  take `accountSid` **and** an optional presented entitlement, and implement the
  OR gate from "Semantics":
  1. Read the trial record for `accountSid`; if `expiresAt > now`, return true
     (no store call).
  2. Else, if the request presented a store entitlement, verify it against the
     store API (this reuses `refreshApple/GoogleSubscription`, so it self-heals
     renewals and updates the store-keyed record), and return whether it's
     active.
  3. Else return false.
- `twilioAccessToken` (`functions/src/index.ts`) passes the presented entitlement
  from `req.data` into the gate. Keep the `failed-precondition`
  `'subscription-expired'` error for the false case.

### Inbound calls and SMS notifications: per-device entitlement (decided)

A paid subscription belongs to a person, but the inbound webhooks only know the
line (`AccountSid`). Gating per line was wrong both ways: checking only the trial
silenced paying users once the trial ended, and an account-level paid flag
(`/twilio/{sid}/paid`, tried and removed) let one customer's subscription cover
everyone on the line. So entitlement is resolved per **device**:

- **Device registry** `/twilio/{sid}/devices/{uid}` (`DeviceRecord` in
  `functions/src/shared/webhooks.ts`), keyed by the device's anonymous Firebase
  uid, server-only: `{ subscription, fcmToken, lastSeen }`. `subscription` is a
  **pointer** to the device user's store record (`subscriptions/{apple|google}/…`)
  — never a copy, so renewals/refunds from store notifications apply without the
  device checking in.
- **`twilioAccessToken`** (after `verifyTwilioCredentials`) runs
  `resolveDeviceEntitlement`: entitled = line trial live OR the presented
  entitlement re-verifies as active; it records the pointer and `lastSeen`, and
  mints a token with the device's **own Voice identity** `<AccountSid>_<uid>`.
  During the trial a device presenting a purchase gets its pointer once, so it
  keeps working the moment the trial ends. Not entitled → `subscription-expired`.
- **`twilioRegisterMessagingDevice`** stores the device's FCM token on its record
  (and removes the token from the legacy `messaging-tokens` registry).
- **Inbound webhooks** (function and Worker share `entitledDevices`): while the
  line's trial is live every fresh device is entitled; after it, only devices
  whose pointed-at record hasn't expired. Calls `<Dial>` those devices'
  identities (max 10, most recent first); SMS pushes go to their FCM tokens. So
  an unsubscribed co-user on a shared line is neither rung nor notified, while
  subscribed users are.
- **Legacy** (apps that haven't updated: shared identity `<AccountSid>`,
  `messaging-tokens` entries) is included **only while the trial is live** — it
  can't be gated per person.
- **Purchase hook**: a verified, active purchase/restore calls
  `TwilioService.refreshRegistrations()` (via `SubscriptionService
  .onEntitlementVerified`), re-registering calls and SMS at once instead of at
  the next launch.

- **Pointer survives a lapse**: whenever the store returns a record, the device
  points at it even if it has currently lapsed — its expiry already decides
  reachability, and a renewal arriving later (billing retry → store
  notification) reaches the device again without it checking in.
- **Pointer survives an empty check-in**: a token mint with no entitlement
  attached (e.g. after an iOS reinstall wiped the stored entitlement but not the
  uid) keeps the device's pointer instead of clearing it.
- **Presented Apple entitlements are signature-verified**
  (`verifyPresentedAppleTransaction`) before their `originalTransactionId` is
  used, so a forged JWS can't borrow another customer's subscription. They are
  verified **offline**, against their own `signedDate` (no OCSP, no "now"
  validity): the app keeps re-presenting the same stored JWS for as long as the
  subscription lasts, so online checks would eventually reject it, or lock
  paying users out whenever Apple's OCSP responder is unreachable. Server
  notifications are still verified online. Verifiers are built once per
  instance (keeping the library's chain cache) and only the one for the
  payload's claimed environment is tried.
- **Firebase anonymous-account expiry** (~30 days, regardless of activity) has
  no effect on entitlement: data is keyed by `accountSid`/store identity, never
  by uid. If a callable rejects a deleted uid as `unauthenticated`, the app
  recreates the identity and retries once (`_callWithIdentityRecovery`,
  `AccountAuthService.recoverIdentity`); the device then registers under its new
  uid/identity on that call. Registering its FCM token deletes the same install's
  records under older uids, so a stale record's pointer can't keep notifying
  whoever uses that install now.

Accepted consequences: a store outage refuses outgoing calls beyond the trial
but keeps the device's pointer (its record still governs ringing); devices not
seen for a year are ignored.

Separately: a store notification (no account) no longer overwrites a paid
record's `lastAccountSid` with null.

---

## Part 3 — Backend: notification handlers

Both handlers do the same job: map the store event to a store-keyed record and
call the existing refresh, so renewals/cancels/refunds/expiries update the
record in real time. Keep the `isSubscriptionActive` store re-verify as a
belt-and-suspenders fallback for any missed notification.

### Apple — `twilioAppleNotifications` (`onRequest`)

- New `onRequest` function, `region: 'europe-west1'`, **no `enforceAppCheck`**
  (Apple can't send an App Check token).
- **Trust model as implemented:** the handler decodes the payload only to read
  the `originalTransactionId`, then re-fetches authoritative state from Apple's
  Server API (authenticated with our own key). It never trusts the payload's
  expiry/renewal values, so a forged notification cannot inject subscription
  state — at worst it names a real transaction (refreshed accurately) or a bogus
  one (404). This is why the endpoint is safe without full signature
  verification.
- **Signature verification (done):** the JWS `x5c` chain is verified against
  Apple Root CA - G3 (bundled in `functions/certs/`) with Apple's official
  `@apple/app-store-server-library` before anything else runs
  (`verifyAppleNotificationSignature`); forged → 401, OCSP unreachable → 500 so
  Apple redelivers. Production verification needs `apple_iap_key.appAppleId`.
  `decodeAppleSignedPayload` still decodes without verifying — never rely on it
  for trust. See docs/edge-hardening-plan.md §6.4.
- Payload gives `originalTransactionId` and a notification type
  (`DID_RENEW`, `DID_FAIL_TO_RENEW`, `EXPIRED`, `DID_CHANGE_RENEWAL_STATUS`,
  `REFUND`, `GRACE_PERIOD_EXPIRED`, …). For all of them, call
  `refreshAppleSubscription(originalTransactionId)` and let it re-fetch the
  authoritative state — simpler and safer than trusting the notification body.
- Return 200 quickly; Apple retries on non-2xx.

### Google — `onPlaySubscriptionNotification` (Pub/Sub trigger)

- Use `onMessagePublished` from `firebase-functions/v2/pubsub`, subscribed to
  `play-subscription-notifications`, `region: 'europe-west1'`.
- No signature to verify — Pub/Sub delivery + the IAM grant is the trust
  boundary. No App Check concern.
- The message's `subscriptionNotification` carries `purchaseToken` and a
  `notificationType`. Call `refreshGoogleSubscription(purchaseToken, …)` to
  re-fetch authoritative state and update the store-keyed record (following
  `linkedPurchaseToken` to the chain root).

---

## Part 4 — App changes (Flutter)

- **Send the current entitlement on token requests.** Before calling
  `twilioAccessToken`, query current entitlements and include the latest
  transaction in the request:
  - iOS: StoreKit 2 `Transaction.currentEntitlements` → the current
    subscription's `signedTransactionInfo` (JWS).
  - Android: Play Billing `queryPurchases(SUBS)` → the current `purchaseToken`.
  - Files: `lib/services/twilio_service.dart` (the `twilioAccessToken` call),
    `lib/services/subscription_service.dart` (expose "current entitlement").
- **Settings display** (`lib/screens/settings_screen.dart`,
  `lib/services/subscription_service.dart`,
  `lib/models/subscription_status.dart`):
  - Show trial-vs-paid: trial days-left from the per-`accountSid` record; paid
    status from the store entitlement, verified via a callable (a small
    `twilioRefreshSubscription` that runs the verify and returns
    `SubscriptionStatus`) so it self-heals like enforcement.
  - `fetchStatus` stops being the only source; combine "trial record" +
    "verified paid entitlement", preferring paid when active.
  - Purchase buttons unchanged, but "already subscribed" should now be rare —
    when it happens, treat it as "you're subscribed, refreshing" and re-verify
    rather than surfacing it as an error (`_purchase` in
    `settings_screen.dart`).

---

## Part 5 — Migration

- **Trial users:** no change — the trial axis is exactly where it was.
- **Existing paid records** (per-`accountSid`, with store ids stored inline):
  migrate lazily. On the next `verifyApple/GooglePurchase` or the next
  enforcement re-verify, write the store-keyed record; a one-time backfill
  script over `/twilio/*/subscription` can copy any `store != null` records to
  the new location if you'd rather not wait. Expected volume is near-zero today
  (still on test licenses).
- **`database.rules.json`:** add read access for the app to whatever it needs to
  read directly (trial node); paid status is read through the callable, so the
  `/subscriptions/*` tree can stay server-only.

---

## Part 6 — Testing (sandbox)

1. **Apple sandbox renewal loop** — buy a sandbox subscription (renews every ~5
   min, ~6 times then stops). Confirm `twilioAppleNotifications` receives
   `DID_RENEW` and the store-keyed `expiresAt` advances **without placing a
   call**. Reopen Settings → shows active. This is the exact bug that started
   this work.
2. **Google test track** — use Play Console **Send test notification** to
   confirm the Pub/Sub function fires, then a real test purchase to confirm
   `refreshGoogleSubscription` updates the record on renewal.
3. **OR gate** — with an active trial and no purchase, calls work. Let the trial
   lapse with no purchase → calls blocked with `subscription-expired`. Purchase
   → calls work again. Purchase on one device, then sign the same store account
   into a *different* Twilio account on another device → calls work there too
   (paid = per person, any line).
4. **Collision** — two different store accounts subscribing under one
   `accountSid` now produce two independent `/subscriptions/*` records; neither
   overwrites the other, and one cancelling doesn't affect the other.

---

## Build order (suggested)

1. Part 2 (schema + OR gate) — the correctness foundation.
2. Part 4 (app sends entitlement) — so enforcement has something to check.
3. Part 3 Apple notifications — fixes the original sandbox symptom, smaller half.
4. Part 3 Google notifications.
5. Part 5 migration cleanup.

Apple notifications alone (after Parts 2 & 4) resolve the reported bug; Google
and migration can follow.
