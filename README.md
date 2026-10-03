# Dialcrest

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-ffdd00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/steinv)

Dialcrest is a mobile calling and texting app built on the Twilio Voice SDK.
The Flutter/Dart package name in this repo is still `twilio_phone` (its
original name, pre-rebrand) — the app itself now ships as Dialcrest.

## What's in this repo

- **`lib/`** — the Flutter app (iOS + Android). Screens for auth, home/dialer,
  call history, messages, and settings live in `lib/screens/`; Twilio, contacts,
  subscription, and secure-storage logic live in `lib/services/`.
- **`functions/`** — Firebase Cloud Functions (TypeScript) that back the app:
  issuing Twilio Voice access tokens, handling incoming/outgoing call and
  status callbacks, managing push credentials (FCM/APN), and verifying
  App Store/Play subscription purchases (`functions/src/twilio.ts`,
  `functions/src/subscription.ts`).
- **`worker/`** — a Cloudflare Worker that takes over the four Twilio webhooks on
  `dialcrest-hooks.peblet.be`, behind Cloudflare's WAF (see
  [`worker/README.md`](worker/README.md) and
  [`docs/edge-hardening-plan.md`](docs/edge-hardening-plan.md)). Its TwiML, RTDB
  paths and push payload are shared with the functions via
  `functions/src/shared/webhooks.ts`.
- **`site/`** — the marketing site (home, FAQ, privacy policy), built with Vite
  into `dist/` and served by Firebase Hosting (see [`site/README.md`](site/README.md)).
- **`docs/`** — design docs and plans.
- **`AGENTS.md`** — security invariants for anyone (human or agent) changing the
  backend.
- **`store_assets/`** — screenshots/graphics for the App Store and Play Store
  listings.

The app talks to the Cloud Functions for anything that needs a Twilio auth
token or server-side secret; Firebase (Auth, Realtime Database, Cloud
Messaging, App Check) ties the two together.

## Getting started

Prerequisites: [Flutter SDK](https://docs.flutter.dev/get-started/install),
a Firebase project with the Functions/Auth/Database/Storage/Hosting products
enabled, and a Twilio account with a Voice-capable number (the backend creates
the TwiML Apps and wires the numbers itself).

```bash
# Flutter app
flutter pub get
flutter run

# Cloud Functions (from functions/)
npm install
npm run serve     # build + run against the Firebase emulators
npm run deploy     # deploy to the configured Firebase project

# Cloudflare Worker (from worker/) — see worker/README.md for the one-time setup
npm install
npm test
npm run deploy
```

Firebase project IDs and app IDs are defined in `firebase.json`; regenerate
`lib/firebase_options.dart` and the platform config files with `flutterfire
configure` if you point this at a different Firebase project.

Localized strings live in `lib/l10n/*.arb` (English, German, French, Spanish,
Dutch) — run `flutter gen-l10n` after editing them to regenerate
`lib/l10n/generated/`.

## Store screenshots (demo data)

For store/website screenshots, build with `STORE_DEMO` to replace call
history, messages, contact names and the WhatsApp capability with fixed fake
data from `lib/services/store_demo.dart` — no real Twilio traffic needed, and
nothing from the signed-in account's history is shown. You still need to be
signed in to a Twilio account (its number appears in Settings).

```bash
flutter build apk --debug --dart-define=STORE_DEMO=true
adb install -r build/app/outputs/flutter-apk/app-debug.apk

# Clean status bar (fixed 9:41 clock, full battery/signal, no notifications)
adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command enter
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941
adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false

adb shell cmd uimode night yes   # or `no` for light mode
adb exec-out screencap -p > screen.png
```

Without the define the flag is a compile-time `false`, so normal builds are
unaffected. If you change `PhoneCall`, `Message` or `WhatsappCapability`,
update `store_demo.dart` to match. The finished Play Store graphics live in
`store_assets/play/` (upload `01.png` and `02.png` first, in order — they
form one continuous image).

## Cloud Functions

All functions are defined in `functions/src/index.ts` (region `europe-west1`,
project `twilio-phone-peblet`), with business logic split out into
`functions/src/twilio.ts` (Twilio) and `functions/src/subscription.ts`
(Apple/Google subscription verification).

### Callable (invoked from the app via `FirebaseFunctions`/`httpsCallable`)

| Function | What it does | Called from |
| --- | --- | --- |
| `twilioRegister` | Creates/updates the device's Twilio Voice push credential; also runs the "account onboarded" hook that records account creation and starts the 30-day trial. | `lib/services/twilio_service.dart` (`_register()`) |
| `twilioAccessToken` | Verifies the caller's Auth Token, records this device in `/twilio/{sid}/devices` (with a pointer to its user's subscription, if any), then mints a Voice access token with the device's own identity if the line's trial is live or the device presents an active subscription; otherwise refuses (`subscription-expired`). | `lib/services/twilio_service.dart` (`_mintAccessToken()`) |
| `twilioVerifyApplePurchase` | Verifies an App Store transaction and persists the resulting entitlement/expiry. | `lib/services/subscription_service.dart` (`_verifyPurchase()`, iOS) |
| `twilioVerifyGooglePurchase` | Verifies a Play purchase token and persists the resulting entitlement/expiry. | `lib/services/subscription_service.dart` (`_verifyPurchase()`, Android) |
| `twilioRefreshSubscription` | Re-checks the stored entitlement and returns current subscription status (keeps Settings accurate). | `lib/services/subscription_service.dart` (`refreshPaidStatus()`) |
| `twilioGetIncomingAppSid` | Resolves (creating if needed) the tenant's incoming TwiML App SID. | `lib/services/twilio_service.dart` (`getIncomingAppSid()`) |
| `twilioConfigureNumbers` | Wires the given number SIDs to ring this app, restoring any deselected number's original webhook config. | `lib/services/twilio_service.dart` (`configureNumbers()`) |
| `twilioRegisterMessagingDevice` | Verifies the caller's Auth Token, then stores the device's FCM token on its device record so incoming SMS can be pushed to it (while its user is entitled). | `lib/services/twilio_service.dart` (`_registerMessagingDevice()`) |
| `twilioLinkAccount` | Verifies the caller's Twilio credentials and stamps their anonymous Firebase identity with an `accountSid` custom claim, which the RTDB rules use to authorize account-scoped reads/writes (see [Security](#security)). | `lib/services/account_auth_service.dart` (`link()` / `ensureLinked()`) |

### Webhook/trigger (invoked by Twilio, Apple, or Google — never called from the app)

| Function | What it does | Invoked by |
| --- | --- | --- |
| `twilioIncomingCall` | TwiML for an inbound PSTN call; rings the devices whose own user is entitled — the line's trial, or that device's subscription (see [`SUBSCRIPTION_NOTIFICATIONS.md`](SUBSCRIPTION_NOTIFICATIONS.md)). | Twilio, as the number's voice URL |
| `twilioOutgoingCall` | TwiML for an outgoing call placed from the SDK; dials the destination using the account number as caller ID. | Twilio, as the TwiML App's outgoing voice URL |
| `twilioCallStatusChanges` | Status-callback webhook that logs call lifecycle events. | Twilio, as a status callback |
| `twilioIncomingMessage` | TwiML for inbound SMS/MMS; pushes an FCM notification to the devices whose own user is entitled. | Twilio, as the number's SMS URL |
| `twilioAppleNotifications` | App Store Server Notifications V2 webhook; verifies the notification's JWS signature, then re-verifies subscription state from Apple on any lifecycle event. | Apple (see [Subscription renewal notifications](#subscription-renewal-notifications-app-store--play)) |
| `onPlaySubscriptionNotification` | Pub/Sub-triggered; consumes Google Play Real-time Developer Notifications and re-verifies purchase-token state. | Google Play RTDN, via Pub/Sub (see below) |

The four Twilio webhooks verify `X-Twilio-Signature` with the tenant's Auth Token
(stored server-side for exactly that purpose, see [Security](#security)). They are
being migrated to the Cloudflare Worker in `worker/`: the
`WEBHOOK_PUBLIC_BASE_URL` param in `functions/.env.twilio-phone-peblet` decides
which host gets written into newly configured Twilio resources, and
`npm run backfill:webhooks` (in `functions/`, see
`functions/src/scripts/backfillWebhooks.ts`) moves existing tenants. `TWILIO_SIGNATURE_FAIL_CLOSED` in the same
file rejects webhooks for accounts with no stored token once the rollout is done.
Every function is capped at 10 instances (`setGlobalOptions` in `index.ts`).

## Security

### How a device proves it owns a Twilio account (RTDB access)

The app has no username/password login of its own — a user "logs in" by entering
a Twilio **Account SID + Auth Token**, which are stored on-device in secure
storage and sent (over App Check-enforced callables) to the Cloud Functions,
which act on Twilio on the user's behalf. Those credentials never identify the
device to Firebase, though, so some Realtime Database data is stored per account
(`/twilio/{accountSid}/…`) and needs a way to authorize "this device may read/write
*this* account's data."

We solve that with an **anonymous Firebase identity bound to the account SID via a
custom claim**:

1. On startup the app signs in **anonymously** (`AccountAuthService.ensureSignedIn`),
   giving it a Firebase `uid`. This identity carries no personal data and is never
   used as a data key.
2. When the account is known (startup with stored creds, or a fresh login), the app
   calls the **`twilioLinkAccount`** function. It verifies the `(accountSid, authToken)`
   pair by fetching the account from Twilio — which succeeds only for a token that
   authenticates *as that account* — then sets a custom claim `{ accountSid }` on the
   caller's `uid`. So a device can only ever obtain a claim for an account whose
   Auth Token it actually holds.
3. The app force-refreshes its ID token so the claim is live, then reads/writes RTDB
   **directly** (no function on the hot path).
4. **`database.rules.json`** authorizes every client-readable account-scoped node
   (`trial`, `twiml-app-sid`, `configuration`) with
   `auth.token.accountSid === $accountSid` — so possession of the verified claim,
   and nothing else, grants access. Everything else (including `secret`, which
   holds the tenant's Auth Token for webhook signature validation) is
   server-only. There are no publicly readable/writable
   nodes.

**Account switching** works because the claim is re-established on every login:
logging into a different account re-runs `twilioLinkAccount` (re-verifying the new
creds) and overwrites the claim; logout (`AccountAuthService.signOut`) drops the
anonymous identity so its claim can't be reused by the next user on the device.

### Disposable identity & anonymous auto-cleanup

The anonymous identity is deliberately disposable — **all data is keyed by
`accountSid`, never by `uid`** — so it's safe to enable Firebase's
[anonymous-account auto-cleanup](https://firebase.blog/posts/2023/07/best-practices-for-anonymous-authentication)
(which deletes anonymous users ~30 days after creation, regardless of activity;
setting a custom claim does **not** exempt an account — only linking a real
sign-in provider would). If the account is deleted, `AccountAuthService` detects the
now-invalid identity and transparently re-creates it and re-links using the stored
Twilio credentials. The user never has to re-authenticate, and no data is lost.

## Secrets

Every backend secret this project needs lives in **one** Secret Manager
secret, `TWILIO_PEBLET_SECRET`, as a single JSON object — one property per
individual secret. Keeping them all in one secret (instead of one Secret
Manager secret per credential) keeps Secret Manager cost down and gives every
function a single, consistent place to read credentials from.

```json
{
  "android_fcm": { "<FCM v1 service-account JSON>": "..." },
  "ios_apn_pk": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
  "apple_iap_key": {
    "issuerId": "...",
    "keyId": "...",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
    "bundleId": "be.peblet.twilioPhone",
    "appAppleId": 1234567890
  }
}
```

| Property | What it is | Where it comes from |
| --- | --- | --- |
| `android_fcm` | Firebase FCM v1 service-account JSON (shared across all tenants). Also doubles as the Google Play service account — see below | Firebase Console → Project settings → Service accounts → Generate new private key. |
| `ios_apn_pk` | APN VoIP private key (PEM), paired with `IOS_APN_CERTIFICATE` | `apn_key.pem` — see "Enabling iOS push" below. |
| `apple_iap_key` | App Store Connect "In-App Purchase" API key — used to call the App Store Server API to verify/re-verify subscription purchases | App Store Connect → Users and Access → Integrations → In-App Purchase → generate a key; `bundleId` is this app's iOS bundle ID (`be.peblet.twilioPhone`); `appAppleId` is the app's numeric Apple ID (App Store Connect → App Information), needed to verify Production App Store notifications. |

There's no separate Google Play service-account secret: the `android_fcm`
service account is also linked in Google Play Console (Setup → API access)
and granted "View financial data" access there, so the same credentials are
reused to call the Play Developer API and verify subscription purchases —
one fewer credential to manage and rotate.

Set/rotate it with:

```bash
firebase functions:secrets:set TWILIO_PEBLET_SECRET   # set / rotate (paste the full JSON)
firebase functions:secrets:access TWILIO_PEBLET_SECRET # view current value
```

For local emulator runs, the same JSON is read from `functions/.secret.local`
(gitignored) as a normal dotenv `KEY=value` line whose value is the JSON
string, e.g. `TWILIO_PEBLET_SECRET={"android_fcm":{},...}`.

## Enabling iOS push (incoming calls)

iOS push is **disabled by default**. Outgoing calls work without it, but to
**receive** incoming calls an iOS device must be woken by Apple's VoIP push
(PushKit), which Twilio can only do if an APN push credential exists in the
tenant's Twilio account.

The Cloud Function gates the iOS branch on having *both* an APN certificate and
an APN private key:

```ts
// functions/src/twilio.ts
const hasIos = Boolean(iosApnCertificate && iosApnPrivateKey);
```

When either is empty, `createOrUpdatePushCredentials` skips iOS entirely (this is
the current state). To enable it, supply both as described below.

> **Note:** A VoIP push credential can only be created/renewed under an **active
> Apple Developer Program membership** ($99/yr), and the certificate is tied to
> your app's bundle ID. VoIP push also **only works on a physical device** — the
> iOS Simulator can never receive push.

### 1. Create the VoIP Services Certificate (Apple)

1. **App ID** — In the [Apple Developer portal](https://developer.apple.com)
   → *Certificates, Identifiers & Profiles → Identifiers*, ensure your app's
   bundle ID is an **explicit** App ID (not a wildcard) with the **Push
   Notifications** capability enabled.
2. **Create a CSR** — On a Mac, open *Keychain Access → Certificate Assistant →
   Request a Certificate From a Certificate Authority*, choose "Saved to disk".
   This writes a `.certSigningRequest` file and stores a matching private key in
   your keychain.
3. **Issue the cert** — In the portal → *Certificates → ➕ → VoIP Services
   Certificate*, select your App ID, upload the CSR, and download
   `voip_services.cer`.

### 2. Export certificate + private key as PEM

Twilio wants both halves as PEM text. Import `voip_services.cer` into Keychain,
then export it **together with its private key** as a `.p12` (right-click →
Export, set a password). Then split it:

```bash
# Certificate (PEM) -> goes into IOS_APN_CERTIFICATE
openssl x509 -in voip_services.cer -inform DER -out apn_cert.pem -outform PEM

# Private key (PEM) -> goes into the ios_apn_pk field of TWILIO_PEBLET_SECRET
openssl pkcs12 -in VoIP.p12 -nocerts -nodes -out apn_key.pem
```

The certificate and private key are a **keypair** — they only work together.
Renewing the cert generally produces a new keypair, so replace *both* values
when you renew.

### 3. Configure the two values

| Value             | What it is                  | Where it goes                                    | Why there                                             |
| ----------------- | --------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| `apn_cert.pem`    | Public VoIP certificate     | `IOS_APN_CERTIFICATE` string param (`functions/.env.twilio-phone-peblet`) | Public, not secret — declared via `defineString`. |
| `apn_key.pem`     | Private key (sensitive)     | `ios_apn_pk` field inside `TWILIO_PEBLET_SECRET` | Secret — kept in Secret Manager via `defineSecret`.   |

**Certificate** — set it in `functions/.env.twilio-phone-peblet`, replacing the
existing empty `IOS_APN_CERTIFICATE=` line. (Don't put it in `functions/.env`:
the project-specific file is loaded after it and its empty value would win,
silently leaving iOS push disabled.) The certificate is public, so committing it
is fine. PEM is multi-line, so quote it and use real newlines, e.g.:

```dotenv
IOS_APN_CERTIFICATE="-----BEGIN CERTIFICATE-----
MII...
-----END CERTIFICATE-----"
```

**Private key** — it goes in the `ios_apn_pk` property of `TWILIO_PEBLET_SECRET`
(see the [Secrets](#secrets) section above).

### 4. Deploy

```bash
firebase deploy --only functions
```

On the next app launch, `twilioRegister` will detect both values, create the APN
push credential in the tenant's Twilio account, and attach its SID to the Voice
access token — incoming calls will then ring on a physical iOS device.

## Subscription renewal notifications (App Store / Play)

Paid subscriptions are verified server-side (`functions/src/subscription.ts`) and
the resulting expiry is cached in Realtime Database. Auto-renewals happen on
Apple's/Google's side, so the stores need to *tell* the backend when a
subscription renews, lapses, or is refunded — otherwise the cached expiry goes
stale and Settings shows "expired" for a subscription that actually renewed. Set
up both stores' notifications so those events reach the Cloud Functions.

The full design and code plan lives in
[`SUBSCRIPTION_NOTIFICATIONS.md`](SUBSCRIPTION_NOTIFICATIONS.md); this section is
just the console setup for the two notification channels.

### Apple — App Store Server Notifications V2

Apple POSTs a signed notification to an HTTPS endpoint for every subscription
lifecycle event (`DID_RENEW`, `EXPIRED`, `DID_FAIL_TO_RENEW`,
`DID_CHANGE_RENEWAL_STATUS`, `REFUND`, …). The `twilioAppleNotifications`
function receives them, verifies the signature against Apple's roots, and
re-verifies the subscription against the App Store Server API.

1. Deploy functions so the endpoint exists:
   `https://europe-west1-twilio-phone-peblet.cloudfunctions.net/twilioAppleNotifications`
2. In **App Store Connect → your app → App Information → App Store Server
   Notifications**, select **Version 2** and set that URL as **both** the
   **Production URL** and the **Sandbox URL** (the signed payload says which
   environment sent it). Sandbox events flow immediately, which is what surfaces
   the fast-renewing test-license renewals without placing a call.

No extra secret is needed — the existing `apple_iap_key` inside
`TWILIO_PEBLET_SECRET` (see [Secrets](#secrets)) authenticates the App Store
Server API. Notification signatures are verified against Apple Root CA - G3
(bundled in `functions/certs/`), checking the bundle id and, for Production, the
app's numeric Apple ID: add it to `apple_iap_key` as `"appAppleId": <number>`
(App Store Connect → App Information → Apple ID; a number, though a numeric
string is accepted too). Without it, Production notifications — and Production
purchases the app presents, which are verified the same way — are rejected (and
an error is logged); only Sandbox ones are processed.

### Google — Real-time Developer Notifications (RTDN)

Google publishes subscription events to a **Cloud Pub/Sub** topic; a Pub/Sub-
triggered function (`onPlaySubscriptionNotification`) consumes them and
re-verifies against the Play Developer API.

1. Create a Pub/Sub topic in the `twilio-phone-peblet` project:

   ```bash
   gcloud pubsub topics create play-subscription-notifications \
     --project twilio-phone-peblet
   ```

2. Let Google Play publish to it (Play uses a fixed system service account):

   ```bash
   gcloud pubsub topics add-iam-policy-binding play-subscription-notifications \
     --project twilio-phone-peblet \
     --member "serviceAccount:google-play-developer-notifications@system.gserviceaccount.com" \
     --role roles/pubsub.publisher
   ```

3. In **Play Console → Monetization setup → Real-time developer
   notifications**, paste the full topic name and enable it:
   `projects/twilio-phone-peblet/topics/play-subscription-notifications`
   Use **Send a test notification** to confirm the wiring once the function is
   deployed.

No extra secret is needed — the `android_fcm` service account inside
`TWILIO_PEBLET_SECRET` already has "View financial data" access in Play Console
and is used as the Play Developer API credential.

### Deploy

```bash
firebase deploy --only functions
```

## License

Dialcrest is open source, licensed under the
[GNU General Public License v3.0](LICENSE). This means anyone is free to use,
study, modify, and redistribute this code, but any distributed derivative
work must also be licensed under the GPLv3 and made available in source form.
