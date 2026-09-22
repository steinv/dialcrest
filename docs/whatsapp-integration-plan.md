# WhatsApp Integration Plan

Status: **planning** (no implementation yet)
Author: stein
Last updated: 2026-09-22

Adds WhatsApp messaging and calling to the existing Twilio-backed softphone, as an
**extra channel on the same rails** — not a separate feature, not a separate tab.

---

## 1. Guiding facts from the current codebase

- **Bring-your-own-Twilio, multi-tenant.** Each user supplies their own Twilio
  `accountSid` + `authToken`; `accountSid` is the tenant key everywhere (RTDB paths,
  Voice `<Client>` identity, Firebase custom claim).
- **No server-side message/call store.** Conversations and call history are a pure
  **client-side projection** of Twilio's `/Messages.json` and `/Calls.json`, grouped by
  the remote number's last-9-digits key. Firebase uses **RTDB** (no Firestore).
- **Channel is already implicit in the data.** WhatsApp messages come back from
  `/Messages.json` with a `whatsapp:` prefix on `From`/`To`, so history "just appears"
  once we parse the prefix. Live delivery uses a data-only FCM fan-out
  (`callbackIncomingMessage` → `messaging-tokens`).
- **Calls go through the `twilio_voice` native SDK**, not REST. Every call funnels
  through `HomeScreen._makeCall`; TwiML is produced by `callbackOutgoingCall` /
  `callbackIncomingCall`.
- There is an explicit `// TODO messaging grant` placeholder (`twilio.ts:314`) — the
  code was written anticipating this.

---

## 2. Backbone: `Channel` as a first-class dimension

Add `enum Channel { sms, whatsapp }` and thread it through models + grouping.

| File | Change |
|---|---|
| `lib/models/message.dart` | add `Channel channel` to `Message` and `Conversation` (+ `toJson`/`fromJson`, default `sms` for old cache entries) |
| `lib/models/call.dart` | add `Channel channel` to `PhoneCall` |
| `lib/services/twilio_service.dart` `_messageFromTwilio` (1367) / `_callFromTwilio` (1112) | derive channel from the `whatsapp:` prefix on From/To; strip prefix to bare E.164 |
| `lib/screens/messages_screen.dart` `_groupConversations` / `_key` (445-463, 105-108) | group by **`(numberKey, channel)`** so the SMS thread and the WhatsApp thread to the same number are two distinct conversations |

This one change makes WhatsApp history appear in the mixed lists on the next REST fetch,
and enforces "opening a conversation stays in the same technology."

---

## 3. Feature guard (central, non-negotiable)

**Binding rule (decided):** WhatsApp is tied to the user's **currently-configured
outgoing number**. The feature is available **iff that exact number is also a WhatsApp
sender**. If the configured number is not a sender → hide everything WhatsApp. If the user
switches outgoing number (`switchOutgoingNumber`), the capability is re-evaluated for the
new number. Consequence: **one sender at a time, no sender picker, and the WhatsApp `from`
== the configured number**. Since the WhatsApp local number equals the SMS local number,
threads separate purely by the `channel` field — no WhatsApp-specific number filtering.

No capability → no choice shown → silent fall-through to today's behavior. The three flags
are independent because the matched sender can message without being able to call, and can
receive calls in countries where it can't place them.

```text
WhatsappCapability {                 // computed FOR the configured outgoing number
  bool     messagingEnabled;         // matched sender status ONLINE / ONLINE:UPDATING
  bool     callingInboundEnabled;    // matched sender voice-enabled + on the calling tier
  bool     callingOutboundEnabled;   // + configured number's country supports business calls
  String?  senderNumber;             // == the configured outgoing number (whatsapp: from)
  String?  senderCountry;            // ISO country of the number, for the outbound gate
}
```

- **Detection (client-side, mirrors `validateCredentials`):**
  `GET https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp` with the
  tenant's Basic Auth (a second Dio base URL `messaging.twilio.com/v2`; no shared secret,
  no new Cloud Function). Then **find the sender whose `sender_id` (`whatsapp:+E164`)
  matches the configured outgoing number** (normalize both to E.164 via the `PhoneNumber`
  helper before comparing). If none matches → all flags false.
  - `messagingEnabled` = the matched sender has `status ∈ {ONLINE, ONLINE:UPDATING}`.
  - `callingInboundEnabled` = the matched sender has a Voice app SID in `configuration`
    **and** `properties.messaging_limit` clears the ~2,000-conv calling tier.
  - `callingOutboundEnabled` = `callingInboundEnabled` **and** `senderCountry` is **not**
    in `WHATSAPP_OUTBOUND_CALL_BLOCKED` (currently US, CA, EG, NG, TR, VN — keep as a
    const, re-check against Twilio docs; the list is expected to change).
- **When:** on credential save / login, **on outgoing-number switch**
  (`setCurrentPhoneNumber` / `switchOutgoingNumber`), and on pull-to-refresh. Cache in
  `StorageService`, keyed by number, so UI never blocks.
- **Exposure:** a `WhatsappCapability` provider (like `ContactsService`). Every widget
  below reads it. If `messagingEnabled == false`, the app is byte-for-byte today's app.

---

## 4. Calling — choice points and backend

Add `HomeScreen._makeWhatsappCall(number)` beside `_makeCall`, and a central chooser:

```text
_callWithChoice(number):
  if capability.callingOutboundEnabled → show "Phone call / WhatsApp call" sheet
  else                                 → _makeCall(number)   // silent fall-through
```

| Requirement | File / location | Change |
|---|---|---|
| **History trailing tap → chooser** (per decision) | `call_history_screen.dart` trailing quick-dial (252-255) | route through `_callWithChoice` |
| History sheet: add "Call with WhatsApp" | `call_history_screen.dart:_showCallActions` (277-305), enum `_CallAction` (11) | new enum case + `ListTile` guarded by `callingOutboundEnabled` → `_makeWhatsappCall` |
| Contact-list dialing: choose | `home_screen.dart:_showContactsPicker` tap (519-522) | route through `_callWithChoice` |
| Dialer: always regular | `widgets/dialer.dart` | **no change** |
| Messages sheet: add "Call with WhatsApp" | `messages_screen.dart:_showConversationActions` (387-391), enum `_ConversationAction` | new case + guarded `ListTile` → `_makeWhatsappCall` |
| SMS thread dial = regular | `home_screen.dart:_buildAppBarActions` case 2 (825-838) | keep `_makeCall` when `channel==sms` |
| WhatsApp thread dial = WhatsApp call | same | when `channel==whatsapp` → `_makeWhatsappCall`; hide/disable if `!callingOutboundEnabled` |

**Backend (Phase 3):**
- `makeCall` passes a WhatsApp flag; `callbackOutgoingCall` (`twilio.ts:362`) branches to
  `<Dial><WhatsApp>…</WhatsApp></Dial>` with the `whatsapp:` sender as callerId.
- Inbound WhatsApp calls reuse the incoming-call → `<Dial><Client>{accountSid}</Client>`
  path; point the sender's voice webhook at the incoming-call function via the Senders API.

**Business-initiated consent sub-flow (required for outbound):**
- WhatsApp requires prior **call-permission** from the recipient before a business call.
- Before placing an outbound WhatsApp call: if permission not held, send a call-permission
  request and tell the user they can call once it's approved. Limits: 1 request / 24h
  (max 2 / 7 days); once approved, 5 calls / 24h for up to 7 days, then re-request.
- Audio only; **cannot bridge to PSTN**.

---

## 5. Messaging — choice points

| Requirement | File / location | Change |
|---|---|---|
| One list, SMS + WhatsApp | `messages_screen.dart:_groupConversations` | key by `(numberKey, channel)`; tile shows a small WhatsApp badge |
| New conversation: choose SMS/WhatsApp | `home_screen.dart:_startNewConversation` / `_openNewConversation` (541-655) | after number pick, if `messagingEnabled` show "SMS / WhatsApp" picker, else default SMS |
| Stay in same technology | `home_screen.dart` `_selectedContact` (String) | carry channel too → `ConversationRef { number, channel }` |
| WhatsApp chat richer than SMS | `messages_screen.dart:_buildThread` / `_buildComposer` (679-731) | composer becomes channel-aware (attach + record for WhatsApp) |
| Send images + voice (WhatsApp only) | composer + `twilio_service.dart:sendMessage` | `sendMessage(to, body, {channel, mediaUrl})`; WhatsApp prefixes From/To with `whatsapp:` and adds `MediaUrl` |

**Receive:** history already works via the REST projection (§2). For **live** WhatsApp
push, add `twilioIncomingWhatsapp` (mirror `callbackIncomingMessage`, `twilio.ts:403`) →
same `messaging-tokens` FCM fan-out with a `channel` field on the payload. Point the
sender's inbound-message webhook at it. **Inbound images/voice reuse the existing
`MessageMediaView`** (image/video/audio already handled) — receiving is nearly free.

---

## 6. Media storage (per decision)

Bucket: **Firebase Storage** (5 GB free tier). Used only as a **send-time staging area** —
Twilio fetches the `MediaUrl` at send, and thereafter keeps its own copy exposed via the
`/Messages/{sid}/Media` subresource, so **history display of sent media reuses the existing
Twilio-media path** exactly like inbound. That's why 7-day retention is safe.

- **Path:** `whatsapp-media/{accountSid}/{messageLocalId}/{filename}`.
- **In-app access control:** Storage security rules scoped to the `accountSid` **custom
  claim** already set by `linkTwilioAccount`, so every (anonymous) device on the same
  Twilio account can read each other's media:
  ```
  match /whatsapp-media/{accountSid}/{allPaths=**} {
    allow read, write: if request.auth.token.accountSid == accountSid;
  }
  ```
- **Twilio's fetch:** Twilio is unauthenticated, so it can't use the SDK path. Hand Twilio
  the **download-token URL** (`…?alt=media&token=…`) which is publicly fetchable by anyone
  holding the unguessable token, independent of the security rules above. The token URL is
  only passed transiently as `MediaUrl`; in-app rendering uses the guarded SDK path.
- **Retention:** a **GCS lifecycle rule** on the `whatsapp-media/` prefix, delete age 7
  days (no Cloud Function invocations, cheapest). After deletion, sent-media display falls
  back to Twilio's copy (above); nothing breaks.
- **Voice capture:** the `record` package. WhatsApp requires **OGG to use the Opus codec**
  (or send AAC/m4a `audio/mp4`). Image via `image_picker`.

---

## 7. Constraints handled gracefully (not blockers)

- **24-hour session window:** free-form WhatsApp only within 24h of the user's last
  inbound; outside it requires an approved **template**. v1: allow free-form, surface
  Twilio error **63016** as "outside the 24-hour window — a template is needed." Templates
  = later phase.
- **No delivery status today.** `Message` has no sent/delivered/failed field; WhatsApp
  users expect ticks. Optional fast-follow: add a status field + status-callback webhook.
- **Recipient WhatsApp capability can't be pre-checked** (WhatsApp forbids it); a message
  to a non-WhatsApp number fails with error **63003** — handle per-message, no pre-check.
- **Switching the outgoing number always closes any open thread and returns to the
  conversation list** — for SMS and WhatsApp alike. Threads are scoped to the current
  outgoing number, so a thread opened under number A is invalid once the user switches to
  number B; you cannot continue a conversation across a number switch. Implementation: the
  outgoing-number-switch handler in `home_screen.dart` (`switchOutgoingNumber` /
  `setCurrentPhoneNumber` path) resets `_selectedContact` / `_selectedChannel` to null.
  This also makes the "WhatsApp thread open on a non-sender number" state unreachable.

---

## 8. Phasing

1. **Phase 1 — WhatsApp messaging (text):** channel model + feature guard + capability
   check + new-conversation picker + mixed list + channel-aware thread + inbound webhook.
   High value, mostly reuses existing rails.
2. **Phase 2 — WhatsApp media:** Firebase Storage upload + lifecycle rule + image/voice
   composer + `record` package. (Receiving already works from Phase 1.)
3. **Phase 3 — WhatsApp calling:** choosers + per-country outbound gate + `<Dial><WhatsApp>`
   TwiML + inbound routing + business-initiated consent/permission flow.
4. **Phase 4 (optional):** delivery status; templates for out-of-window sends.

---

## 9. New/changed surface — quick index

- **Models:** `message.dart` (+channel, +Conversation channel), `call.dart` (+channel),
  new `ConversationRef`, new `WhatsappCapability`.
- **Services:** `twilio_service.dart` (capability check, `sendMessage` channel+media,
  `_makeWhatsappCall`, channel derivation, media upload helper), new capability provider.
- **UI:** `home_screen.dart` (choosers, ConversationRef, new-conversation picker, app-bar
  call routing), `call_history_screen.dart` (trailing chooser + sheet action),
  `messages_screen.dart` (grouping, badge, channel-aware composer + thread dial),
  `widgets/dialer.dart` (unchanged).
- **Backend (`functions/`):** `twilioIncomingWhatsapp` webhook, `callbackOutgoingCall`
  WhatsApp branch, sender webhook config via Senders API, WhatsApp calling consent
  handling, Storage security rules + GCS lifecycle rule.
- **Config:** `WHATSAPP_OUTBOUND_CALL_BLOCKED` country const.
