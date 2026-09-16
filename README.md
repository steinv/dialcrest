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
- **`public/`** — the small static site served by Firebase Hosting (currently
  just the privacy policy).
- **`store_assets/`** — screenshots/graphics for the App Store and Play Store
  listings.

The app talks to the Cloud Functions for anything that needs a Twilio auth
token or server-side secret; Firebase (Auth, Realtime Database, Cloud
Messaging, App Check) ties the two together.

## Getting started

Prerequisites: [Flutter SDK](https://docs.flutter.dev/get-started/install),
a Firebase project with the Functions/Auth/Database/Hosting products enabled,
and a Twilio account with a configured Voice-capable number/TwiML app.

```bash
# Flutter app
flutter pub get
flutter run

# Cloud Functions (from functions/)
npm install
npm run serve     # build + run against the Firebase emulators
npm run deploy     # deploy to the configured Firebase project
```

Firebase project IDs and app IDs are defined in `firebase.json`; regenerate
`lib/firebase_options.dart` and the platform config files with `flutterfire
configure` if you point this at a different Firebase project.

Localized strings live in `lib/l10n/*.arb` (English, German, French, Spanish,
Dutch) — run `flutter gen-l10n` after editing them to regenerate
`lib/l10n/generated/`.

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
    "bundleId": "be.peblet.twilio_phone"
  }
}
```

| Property | What it is | Where it comes from |
| --- | --- | --- |
| `android_fcm` | Firebase FCM v1 service-account JSON (shared across all tenants). Also doubles as the Google Play service account — see below | Firebase Console → Project settings → Service accounts → Generate new private key. |
| `ios_apn_pk` | APN VoIP private key (PEM), paired with `IOS_APN_CERTIFICATE` | `apn_key.pem` — see "Enabling iOS push" below. |
| `apple_iap_key` | App Store Connect "In-App Purchase" API key — used to call the App Store Server API to verify/re-verify subscription purchases | App Store Connect → Users and Access → Integrations → In-App Purchase → generate a key; `bundleId` is this app's iOS bundle ID. |

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
| `apn_cert.pem`    | Public VoIP certificate     | `IOS_APN_CERTIFICATE` string param (`functions/.env`) | Public, not secret — declared via `defineString`. |
| `apn_key.pem`     | Private key (sensitive)     | `ios_apn_pk` field inside `TWILIO_PEBLET_SECRET` | Secret — kept in Secret Manager via `defineSecret`.   |

**Certificate** — add it to `functions/.env` (gitignored). PEM is multi-line, so
quote it and use real newlines, e.g.:

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
Server API and is what notification signatures are validated against.

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
