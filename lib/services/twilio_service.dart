import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart' hide Message;
import 'package:intl/intl.dart';
import 'package:dialcrest/dto/IncomingPhoneNumbers.dart';
import 'package:dialcrest/models/PhoneNumber.dart';
import 'package:twilio_voice/twilio_voice.dart' hide Call;
import '../../models/call.dart';
import '../../models/message.dart';
import '../l10n/generated/app_localizations.dart';
import '../l10n/generated/app_localizations_en.dart';
import 'storage_service.dart';

/// Looks up the localized strings for the device's current locale without a
/// [BuildContext] (this file is a plain service, not a widget) — falls back
/// to English if the device locale isn't one [AppLocalizations] supports.
AppLocalizations _l10n() {
  try {
    return lookupAppLocalizations(ui.PlatformDispatcher.instance.locale);
  } on FlutterError {
    return AppLocalizationsEn();
  }
}

/// One page of call history from Twilio, plus the URL to fetch the next page
/// (null when there are no more pages).
class CallHistoryPage {
  final List<PhoneCall> calls;
  final String? nextPageUrl;

  CallHistoryPage({required this.calls, this.nextPageUrl});
}

/// One page of messages from Twilio, plus the URL to fetch the next page (null
/// when there are no more pages).
class MessagePage {
  final List<Message> messages;
  final String? nextPageUrl;

  MessagePage({required this.messages, this.nextPageUrl});
}

/// Outcome of a bulk [TwilioService.deleteMessages] (e.g. deleting a whole
/// spam conversation): the SIDs that were actually removed from Twilio, and
/// the first error hit, if any. [deleted] is populated even when [error] is
/// set, so the caller can still prune the messages that did get deleted from
/// its cache before surfacing the failure.
class BulkDeleteResult {
  final List<String> deleted;
  final String? error;

  BulkDeleteResult({required this.deleted, this.error});

  bool get hadError => error != null;
}

/// Thrown when twilioAccessToken refuses to mint a token because this
/// account's trial/subscription has expired (functions/src/index.ts,
/// 'failed-precondition' / 'subscription-expired'). Kept unwrapped by
/// makeCall's catch-all so this friendly message reaches the UI as-is instead
/// of being buried in a generic "Failed to make call: ..." string.
class SubscriptionExpiredException implements Exception {
  @override
  String toString() =>
      'Your Dialcrest subscription has expired. Open Settings to renew.';
}

/// Wraps an already-clean, user-presentable message (typically the output of
/// [describeTwilioError]) without [Exception]'s own "Exception: " prefix, so
/// callers that already add their own "Failed to ..." wrapper don't end up
/// with a doubled-up message.
class _TwilioApiException implements Exception {
  final String _message;
  _TwilioApiException(this._message);
  @override
  String toString() => _message;
}

/// Whether [error] is a "you're offline / the network is unreachable" failure
/// rather than a real server- or account-side problem — no Wi-Fi and no mobile
/// data, a dropped connection, or a request that timed out before it got a
/// response. These all deserve the same friendly "check your connection"
/// message instead of a raw `SocketException` / `[unavailable]` / DioException
/// dump. Every transport we use is covered: Twilio REST via Dio, Firebase
/// callable functions, and Realtime Database (subscription status).
bool isOfflineError(Object error) {
  if (error is SocketException) return true;
  if (error is DioException) {
    switch (error.type) {
      case DioExceptionType.connectionError:
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
        return true;
      default:
        // Some platforms surface an offline device as an unknown-type
        // DioException wrapping the underlying SocketException.
        return error.error is SocketException;
    }
  }
  // FirebaseFunctionsException is itself a FirebaseException, so this covers
  // callable functions and Realtime Database alike: an unreachable backend
  // comes back as 'unavailable' (and occasionally 'deadline-exceeded').
  if (error is FirebaseException) {
    final code = error.code.toLowerCase();
    return code.contains('unavailable') ||
        code.contains('deadline') ||
        code.contains('network');
  }
  return false;
}

/// A short, user-presentable description of [error] for the "Failed to ..."
/// messages surfaced in the UI. [DioException.toString] dumps the request
/// options and the raw response object, and [FirebaseFunctionsException]
/// (like every [FirebaseException]) appends its full stack trace when one is
/// attached — both read like a stack trace once shown on-screen. This
/// extracts just the actual error message: Twilio's own JSON error body
/// `message` field for a Dio failure (e.g. "Authentication Error - invalid
/// username" for a suspended/expired Twilio account) plus the HTTP status, or
/// the "[plugin/code] message" prefix for a Firebase exception.
String describeTwilioError(Object error) {
  // Offline is the common case (Wi-Fi off, no mobile data) and has nothing to
  // do with Twilio or the account, so give it a plain "check your connection"
  // message before any transport-specific unwrapping below.
  if (isOfflineError(error)) return _l10n().noInternetConnection;
  if (error is DioException) {
    final status = error.response?.statusCode;
    final body = error.response?.data;
    final twilioMessage = body is Map ? body['message'] as String? : null;
    if (twilioMessage != null) {
      return status != null ? '$twilioMessage (HTTP $status)' : twilioMessage;
    }
    if (status != null) return 'HTTP $status';
    return error.message ?? 'network error';
  }
  if (error is FirebaseFunctionsException) {
    // Callable functions collapse any error that isn't explicitly thrown as an
    // HttpsError (e.g. an unhandled Twilio API error inside twilio.ts) into
    // code 'internal'/message 'INTERNAL' before it reaches the client, so the
    // actual cause never makes it here — "[internal] INTERNAL" would just
    // confuse the user. Since that almost always means the underlying Twilio
    // call failed (bad/revoked credentials, suspended or trial-restricted
    // account, etc.), point them at the Twilio account instead.
    if (error.code == 'internal') {
      return _l10n().twilioAccountError;
    }
    return '[${error.code}] ${error.message}';
  }
  // A plain `Exception('...')` stringifies as "Exception: ...". Some of these
  // carry a genuinely user-facing message (e.g. the permission prompts in
  // makeCall), so keep the text but drop the leaked "Exception: " prefix.
  final text = error.toString();
  const exceptionPrefix = 'Exception: ';
  return text.startsWith(exceptionPrefix)
      ? text.substring(exceptionPrefix.length)
      : text;
}

class TwilioService {
  final String accountSid;
  final String authToken;
  String? currentPhoneNumber;

  /// Resolves once the startup caller-id lookup in [_initializeClient] has
  /// set [currentPhoneNumber] (or given up because there are no numbers /
  /// the fetch failed). Callers that need a reliable [currentPhoneNumber] —
  /// makeCall, sendMessage, Settings — await [ensureCurrentPhoneNumberResolved]
  /// instead of racing that startup fetch and reading a still-null value.
  late final Future<void> _currentPhoneNumberResolved;

  final Dio _dio = Dio();
  final FirebaseFunctions _firebaseFunctions = FirebaseFunctions.instanceFor(
    region: 'europe-west1',
  );
  final StorageService _storageService;

  // Callbacks for incoming communications
  Function(String from)? onIncomingCall;

  /// Fires while the app is foregrounded and a text arrives — drives the
  /// in-app [NotificationOverlay] banner. In practice this only fires on iOS:
  /// on Android, incoming-message pushes are handled natively instead (see
  /// [_incomingMessageChannel] below), because this app's Twilio Voice FCM
  /// service is Android's one registered FirebaseMessagingService, so
  /// [FirebaseMessaging.onMessage] never reaches Dart there.
  Function(String from, String body)? onIncomingMessage;

  /// Fires when the user taps a system/local notification for an incoming
  /// text (app was backgrounded or fully killed) and the conversation should
  /// just be opened directly — no banner moment, unlike [onIncomingMessage].
  Function(String from, String body)? onOpenConversation;

  /// Android equivalent of `FirebaseMessaging.getInitialMessage()`/
  /// `onMessageOpenedApp` — see IncomingMessageFcmHandler.kt/MainActivity.kt.
  static const _incomingMessageChannel =
      MethodChannel('be.peblet.twilio_phone/incoming_message');

  /// iOS only in practice: shows/detects taps on the local notification built
  /// from the silent/data-only FCM push while backgrounded/terminated (see
  /// _firebaseMessagingBackgroundHandler in main.dart). Unused on Android,
  /// where IncomingMessageFcmHandler.kt shows a native notification instead.
  final FlutterLocalNotificationsPlugin _localNotifications =
      FlutterLocalNotificationsPlugin();

  StreamSubscription<RemoteMessage>? _onMessageSubscription;

  /// How long a completed twilioRegister run stays valid before being redone.
  /// Registration is idempotent server-side, but re-running it walks every
  /// Twilio API involved (push credentials, TwiML app, all incoming numbers),
  /// so skipping it on most launches saves several REST round-trips. This
  /// bounds how stale that config can get — e.g. a phone number added to the
  /// Twilio account after the last registration won't get its webhooks wired
  /// up until the next one.
  static const _registerRevalidationInterval = Duration(days: 1);

  // In-memory cache for the access token, keyed off the server's TTL
  // (functions/src/twilio.ts) so makeCall() and startup registration reuse
  // one token instead of minting a new one on every call.
  String? _cachedAccessToken;
  DateTime? _cachedAccessTokenExpiry;
  static const _accessTokenTtl = Duration(seconds: 600);
  static const _accessTokenRefreshBuffer = Duration(seconds: 60);

  // FCM rotates the device token occasionally (token TTL, app reinstall/data
  // clear, restore to a new device, etc). Without re-pushing it to Twilio via
  // setTokens(), the old binding just silently stops receiving incoming-call
  // pushes, so re-register whenever it fires instead of only at app startup.
  StreamSubscription<String>? _tokenRefreshSubscription;

  /// Returns the store entitlement fields to attach to twilioAccessToken (empty
  /// for a trial-only device). Injected rather than reaching into
  /// SubscriptionService directly, to keep the two services decoupled. See
  /// SubscriptionService.currentEntitlement.
  final Map<String, String> Function()? entitlementProvider;

  /// Attempts to silently recover a paid entitlement this device owns but
  /// hasn't cached, returning whether one is now available. Called once when a
  /// token request is refused as subscription-expired, to cover a paid device
  /// that dials before the startup restore finished (or before opening
  /// Settings). See SubscriptionService.recoverEntitlement.
  final Future<bool> Function()? entitlementRecovery;

  TwilioService({
    required this.accountSid,
    required this.authToken,
    required StorageService storageService,
    this.entitlementProvider,
    this.entitlementRecovery,
  }) : _storageService = storageService {
    _initializeClient();
    _tokenRefreshSubscription = FirebaseMessaging.instance.onTokenRefresh.listen((_) {
      _registerVoice();
      _registerMessagingDevice();
    });
    _initializeIncomingMessageHandling();
  }

  void dispose() {
    _tokenRefreshSubscription?.cancel();
    _onMessageSubscription?.cancel();
  }

  /// Sets up everything needed to notify the user of an incoming text: asks
  /// for notification permission, registers this device's FCM token so the
  /// twilioIncomingMessage webhook can reach it, and wires up both the
  /// foreground banner path (onIncomingMessage, effectively iOS-only) and the
  /// "tap a notification to open the conversation" path (onOpenConversation,
  /// covering a cold start and an already-running tap on both platforms).
  Future<void> _initializeIncomingMessageHandling() async {
    try {
      await FirebaseMessaging.instance.requestPermission();
      await _registerMessagingDevice();

      await _localNotifications.initialize(
        settings: const InitializationSettings(iOS: DarwinInitializationSettings()),
        onDidReceiveNotificationResponse: (details) =>
            _handleNotificationPayload(details.payload),
      );
      final launchDetails = await _localNotifications.getNotificationAppLaunchDetails();
      if (launchDetails?.didNotificationLaunchApp == true) {
        _handleNotificationPayload(launchDetails!.notificationResponse?.payload);
      }

      _onMessageSubscription = FirebaseMessaging.onMessage.listen(_handleForegroundMessage);

      _incomingMessageChannel.setMethodCallHandler((call) async {
        if (call.method == 'onIncomingMessage') _handleNativeExtras(call.arguments);
      });
      final initialExtras = await _incomingMessageChannel
          .invokeMethod<Map<Object?, Object?>>('getInitialIncomingMessage');
      _handleNativeExtras(initialExtras);
    } catch (e, stackTrace) {
      debugPrint('Error initializing incoming-message handling: $e');
      debugPrintStack(stackTrace: stackTrace);
    }
  }

  void _handleForegroundMessage(RemoteMessage message) {
    if (message.data['dialcrest_type'] != 'incoming_message') return;
    if (isVacationMode) return;
    onIncomingMessage?.call(message.data['from'] ?? '', message.data['body'] ?? '');
  }

  /// Extras from a tapped [IncomingMessageFcmHandler] Android notification,
  /// forwarded either at cold start or live via MainActivity.onNewIntent.
  void _handleNativeExtras(Map<Object?, Object?>? extras) {
    if (extras == null) return;
    final from = extras['from'] as String?;
    if (from == null) return;
    onOpenConversation?.call(from, (extras['body'] as String?) ?? '');
  }

  /// A tapped iOS local notification, built by _firebaseMessagingBackgroundHandler
  /// (main.dart) with a JSON-encoded {from, body} payload.
  void _handleNotificationPayload(String? payload) {
    if (payload == null) return;
    try {
      final decoded = jsonDecode(payload) as Map<String, dynamic>;
      final from = decoded['from'] as String?;
      if (from == null) return;
      onOpenConversation?.call(from, (decoded['body'] as String?) ?? '');
    } catch (e) {
      debugPrint('Error decoding notification payload: $e');
    }
  }

  /// Registers (or refreshes) this device's FCM token with the backend so
  /// twilioIncomingMessage's webhook can push incoming-SMS notifications to
  /// it. Independent of _registerVoice()/setTokens(), which only registers
  /// the token with Twilio itself for Voice pushes.
  Future<void> _registerMessagingDevice() async {
    try {
      final token = await FirebaseMessaging.instance.getToken();
      if (token == null) return;
      await _firebaseFunctions.httpsCallable('twilioRegisterMessagingDevice').call({
        'accountSid': accountSid,
        'fcmToken': token,
      });
    } catch (e) {
      debugPrint('Error registering messaging device: $e');
    }
  }

  /// Verifies a Twilio Account SID / Auth Token pair against the Twilio REST API
  /// without any of the constructor's voice-registration side effects. Fetches
  /// the account resource itself: 200 means the credentials are valid, 401 means
  /// they are wrong. Returns `true`/`false`; rethrows other errors (e.g. no
  /// network) so the caller can distinguish "bad credentials" from "couldn't
  /// check".
  static Future<bool> validateCredentials(String accountSid, String authToken) async {
    final credentials = base64.encode(utf8.encode('$accountSid:$authToken'));
    try {
      await Dio().get(
        'https://api.twilio.com/2010-04-01/Accounts/$accountSid.json',
        options: Options(headers: {'authorization': 'Basic $credentials'}),
      );
      return true;
    } on DioException catch (e) {
      // 401 (and 403/404 for a wrong SID) mean the credentials don't work.
      // Anything else (timeout, no DNS, 5xx) isn't a credential verdict.
      final status = e.response?.statusCode;
      // Twilio returns a JSON body like {"code":20003,"message":"Authentication
      // Error - ..."} on auth failures; logging it turns a vague "invalid
      // credentials" into the exact reason (wrong key type, rotated token, etc.).
      debugPrint('validateCredentials: status=$status body=${e.response?.data} type=${e.type}');
      if (status == 401 || status == 403 || status == 404) return false;
      rethrow;
    }
  }

  /// https://pub.dev/packages/twilio_voice/example
  void _initializeClient() {
    // Set up basic auth for Twilio API
    final credentials = '$accountSid:$authToken';
    final encodedCredentials = base64.encode(utf8.encode(credentials));
    _dio.options.headers['authorization'] = 'Basic $encodedCredentials';
    _dio.options.baseUrl = 'https://api.twilio.com/2010-04-01/Accounts/$accountSid';

    // Ensure the Android ConnectionService PhoneAccount is registered and enabled
    // so calls integrate with the system dialer (and the "PhoneAccount is not
    // enabled" warning goes away). Runs independently of the network calls below.
    _ensurePhoneAccount();

    // Register this device with Twilio Voice independently of caller-id
    // resolution below: this is what runs twilioRegister server-side, which
    // starts the account's 30-day trial (see ensureTrialStarted) on first
    // launch — that must happen even if the phone-number fetch below fails,
    // otherwise a new account looks like its trial already expired (Settings
    // reads no subscription record and reports "expired" rather than "never
    // registered" — see SubscriptionService.fetchStatus).
    _registerVoice();

    // Resolve the caller-id number used for outgoing calls/access-token minting.
    _currentPhoneNumberResolved = _resolveCurrentPhoneNumber();
  }

  Future<void> _resolveCurrentPhoneNumber() async {
    try {
      final phoneNumbers = await getPhoneNumbers();
      if (phoneNumbers == null || phoneNumbers.isEmpty) return;
      // Prefer the number the user previously picked in Settings, as long as
      // it's still on the account; otherwise fall back to the first number.
      final selected = _storageService.getSelectedPhoneNumber(accountSid);
      currentPhoneNumber = (selected != null && phoneNumbers.contains(selected))
          ? selected
          : phoneNumbers.first;
    } catch (e) {
      // A transient connectivity failure (e.g. no DNS for api.twilio.com) must
      // not become an unhandled exception during startup; the user can still
      // pick a caller id later from Settings once the account is reachable.
      debugPrint('Skipping caller-id resolution, phone-number fetch failed: $e');
    }
  }

  /// Waits for the startup caller-id lookup to finish, so [currentPhoneNumber]
  /// is never read while that fetch is still in flight (e.g. a call placed or
  /// Settings opened right after login, before the first REST round-trip
  /// completes). Safe to call any number of times — it just awaits the same
  /// underlying future.
  Future<void> ensureCurrentPhoneNumberResolved() => _currentPhoneNumberResolved;

  /// Requests the two Android permissions [registerPhoneAccount] itself
  /// needs — READ_PHONE_STATE and READ_PHONE_NUMBERS
  Future<List<String>> _ensurePhoneAccountPermissions() async {
    final platform = TwilioVoicePlatform.instance;

    if (!await platform.hasReadPhoneStatePermission()) {
      await platform.requestReadPhoneStatePermission();
    }
    if (!await platform.hasReadPhoneNumbersPermission()) {
      await platform.requestReadPhoneNumbersPermission();
    }
    final hasPhoneState = await platform.hasReadPhoneStatePermission();
    final hasPhoneNumbers = await platform.hasReadPhoneNumbersPermission();

    return [
      if (!hasPhoneState) 'Phone state',
      if (!hasPhoneNumbers) 'Phone numbers',
    ];
  }

  /// Requests CALL_PHONE and microphone access — a no-op for whichever is
  /// already granted. Deliberately *not* called at startup: these are the two
  /// most user-visible permissions (especially the mic), so they're only
  /// requested here, right before [makeCall] actually places a call, instead
  /// of prompting before the user has done anything that needs them. Returns
  /// the human-readable names of whichever are still denied afterwards, so
  /// callers can decide whether that's fatal.
  Future<List<String>> _ensureCallPermissions() async {
    final platform = TwilioVoicePlatform.instance;

    if (!await platform.hasCallPhonePermission()) {
      await platform.requestCallPhonePermission();
    }
    if (!await platform.hasMicAccess()) {
      await platform.requestMicAccess();
    }

    return [
      if (!await platform.hasCallPhonePermission()) 'Phone calls',
      if (!await platform.hasMicAccess()) 'Microphone',
    ];
  }

  /// Registers the ConnectionService PhoneAccount and, if it is registered but
  /// not yet enabled, opens system settings so the user can flip the toggle.
  /// Android requires this one-time manual step for security; afterwards the
  /// "PhoneAccount is not enabled" warning no longer fires.
  Future<void> _ensurePhoneAccount() async {
    try {
      final missingPermissions = await _ensurePhoneAccountPermissions();
      // This runs silently at startup (no UI to explain a permission
      // prompt), so only bail out on the two permissions registerPhoneAccount
      // itself needs. CALL_PHONE/Microphone are only requested once the user
      // actually places a call — makeCall() requests and reports those with a
      // proper message at that point.
      if (missingPermissions.isNotEmpty) {
        debugPrint('Skipping phone account setup: required permissions were denied.');
        return;
      }
      await TwilioVoicePlatform.instance.registerPhoneAccount();
      if (!await TwilioVoicePlatform.instance.isPhoneAccountEnabled()) {
        await TwilioVoicePlatform.instance.openPhoneAccountSettings();
      }
    } catch (e) {
      debugPrint('Error ensuring phone account is enabled: $e');
    }
  }

  /// Ensures push credentials exist in the user's Twilio account, mints a Voice
  /// access token server-side, and registers this device's FCM token with Twilio
  /// so it can receive incoming-call pushes (and place outgoing calls).
  ///
  /// Skips the device-token registration step while [isVacationMode] is on —
  /// that's a per-device pause (this device stops ringing, and — see
  /// _handleForegroundMessage and the native/background handlers — stops
  /// showing incoming-message notifications too) that must survive restarts
  /// and FCM token refreshes, not just the moment the switch is flipped. It
  /// never touches account-level Twilio config, so every other client
  /// sharing this Twilio account keeps ringing and getting notified as normal.
  Future<void> _registerVoice() async {
    try {
      await _registerIfNeeded();
      if (isVacationMode) return;
      final accessToken = await _accessToken();
      final deviceToken = await FirebaseMessaging.instance.getToken();
      await TwilioVoicePlatform.instance.setTokens(accessToken: accessToken, deviceToken: deviceToken);
    } catch (e, stackTrace) {
      debugPrint('Error registering Twilio Voice: $e');
      debugPrintStack(stackTrace: stackTrace);
    }
  }

  /// Whether this device is paused from receiving incoming-call pushes. Purely
  /// a local, per-device setting — see [setVacationMode].
  bool get isVacationMode => _storageService.getVacationMode(accountSid);

  /// Turns "vacation mode" on or off for this device. On: unregisters this
  /// device's push binding, so it stops ringing for incoming calls, and
  /// incoming-message notifications on this device are suppressed too (see
  /// _handleForegroundMessage, _firebaseMessagingBackgroundHandler in
  /// main.dart, and IncomingMessageFcmHandler.kt). Off: re-registers it and
  /// notifications resume. Either way, this only affects this device/install
  /// — no Twilio account or phone-number configuration is touched, so other
  /// clients sharing this Twilio account are never affected, and messages are
  /// still delivered/stored server-side (visible when the conversation is
  /// opened). Outgoing calls and texts from this device are unaffected too.
  Future<void> setVacationMode(bool vacationMode) async {
    await _storageService.setVacationMode(accountSid, vacationMode);
    if (vacationMode) {
      try {
        final accessToken = await _accessToken();
        await TwilioVoicePlatform.instance.unregister(accessToken: accessToken);
      } catch (e, stackTrace) {
        debugPrint('Error unregistering Twilio Voice for vacation mode: $e');
        debugPrintStack(stackTrace: stackTrace);
      }
    } else {
      await _registerVoice();
    }
  }

  /// Calls twilioRegister unless it already ran for this account within
  /// [_registerRevalidationInterval], per the timestamp persisted in
  /// [StorageService].
  Future<void> _registerIfNeeded() async {
    final lastRegistered = _storageService.getLastVoiceRegistration(accountSid);
    final isStale = lastRegistered == null ||
        DateTime.now().difference(lastRegistered) > _registerRevalidationInterval;
    if (!isStale) return;

    await _register();
    await _storageService.setLastVoiceRegistration(accountSid, DateTime.now());
  }

  /// Creates (or updates) the FCM/APN push credentials in the user's Twilio
  /// account via the twilioRegister Cloud Function. Idempotent server-side.
  Future<void> _register() async {
    await _firebaseFunctions
        .httpsCallable('twilioRegister')
        .call({'accountSid': accountSid, 'authToken': authToken});
  }

  /// Requests a Twilio Voice access token from the twilioAccessToken Cloud
  /// Function, reusing the last-minted one until it's close to expiry (the
  /// server mints tokens with a 600s TTL — see functions/src/twilio.ts).
  /// Minting happens server-side so the push credential SID is added to the
  /// grant and the Twilio auth token logic stays on the backend.
  Future<String> _accessToken() async {
    final cachedToken = _cachedAccessToken;
    final cachedExpiry = _cachedAccessTokenExpiry;
    if (cachedToken != null &&
        cachedExpiry != null &&
        DateTime.now().isBefore(cachedExpiry.subtract(_accessTokenRefreshBuffer))) {
      return cachedToken;
    }

    try {
      return await _mintAccessToken();
    } on SubscriptionExpiredException {
      // The trial has lapsed and we presented no active entitlement. On a device
      // that owns a subscription but hasn't cached it yet (fresh install / new
      // device, dialing before the startup restore finished), try to recover it
      // silently once, then retry before surfacing the expiry to the user.
      final recover = entitlementRecovery;
      if (recover == null || !await recover()) rethrow;
      return await _mintAccessToken();
    }
  }

  Future<String> _mintAccessToken() async {
    try {
      final response = await _firebaseFunctions.httpsCallable('twilioAccessToken').call({
        'accountSid': accountSid,
        'authToken': authToken,
        'callerId': currentPhoneNumber ?? '',
        // Attach the device's paid store entitlement, if any, so the backend's
        // OR gate can grant access on an active subscription once the trial has
        // lapsed. Empty for trial-only devices.
        ...?entitlementProvider?.call(),
      });
      final token = response.data as String;
      _cachedAccessToken = token;
      _cachedAccessTokenExpiry = DateTime.now().add(_accessTokenTtl);
      return token;
    } on FirebaseFunctionsException catch (e) {
      if (e.code == 'failed-precondition' && e.message == 'subscription-expired') {
        throw SubscriptionExpiredException();
      }
      rethrow;
    }
  }

  /// Switches the caller-id number used for outgoing calls and access-token
  /// minting, persists the choice for [accountSid] so it survives restarts,
  /// and re-registers Voice so the cached access token (bound to the old
  /// caller id) is replaced before the next call.
  Future<void> setCurrentPhoneNumber(String phoneNumber) async {
    currentPhoneNumber = phoneNumber;
    await _storageService.setSelectedPhoneNumber(accountSid, phoneNumber);
    _cachedAccessToken = null;
    _cachedAccessTokenExpiry = null;
    await _registerVoice();
  }

  /// Headers needed to fetch a Twilio Media resource URL directly (e.g. from
  /// `Image.network` or `VideoPlayerController.networkUrl`) — those files sit
  /// behind the same Basic Auth as the rest of the REST API.
  Map<String, String> get mediaHeaders =>
      {'authorization': _dio.options.headers['authorization'] as String};

  /// Downloads the bytes of a Twilio Media resource URL. Used for playback
  /// paths (audioplayers) that can't take custom request headers themselves.
  Future<Uint8List> downloadMedia(String url) async {
    final response = await _dio.get<List<int>>(
      url,
      options: Options(responseType: ResponseType.bytes),
    );
    return Uint8List.fromList(response.data!);
  }

  Future<List<IncomingPhoneNumbers>> _fetchIncomingPhoneNumbers() async {
    final response = await _dio.get('/IncomingPhoneNumbers.json');
    final List<dynamic> phoneNumbers = response.data['incoming_phone_numbers'];
    return phoneNumbers
        .map((it) => IncomingPhoneNumbers.fromJson(it))
        .where((number) => number.status == 'in-use')
        .toList();
  }

  Future<List<String>?> getPhoneNumbers() async {
    try {
      final numbers = await _fetchIncomingPhoneNumbers();
      final phoneNumberStrings = numbers.map((number) => number.phone_number).toList();
      unawaited(_reregisterForNewNumbers(phoneNumberStrings));
      return phoneNumberStrings;
    } catch (e) {
      debugPrint('Error fetching phoneNumbers: $e');
      throw _TwilioApiException(describeTwilioError(e));
    }
  }

  /// Full number resources (sid + current voice_application_sid), used by the
  /// per-number webhook-configuration UI in Settings to show which numbers are
  /// currently wired up to ring this app.
  Future<List<IncomingPhoneNumbers>> getIncomingNumbers() async {
    try {
      return await _fetchIncomingPhoneNumbers();
    } catch (e) {
      debugPrint('Error fetching incoming numbers: $e');
      // No "Failed to ..." prefix here: the caller (Settings) already adds its
      // own "Could not load phone numbers: ..." wrapper around this.
      throw _TwilioApiException(describeTwilioError(e));
    }
  }

  /// The tenant's incoming TwiML App SID (created on first use). A number is
  /// configured for this app iff its voice_application_sid equals this.
  Future<String> getIncomingAppSid() async {
    try {
      final response = await _firebaseFunctions
          .httpsCallable('twilioGetIncomingAppSid')
          .call({'accountSid': accountSid, 'authToken': authToken});
      return response.data as String;
    } catch (e) {
      debugPrint('Error fetching incoming app sid: $e');
      // No "Failed to ..." prefix here: the caller (Settings) already adds
      // its own "Could not load phone numbers: ..." wrapper around this.
      throw _TwilioApiException(describeTwilioError(e));
    }
  }

  /// Configures exactly [selectedSids] to ring this app; any previously
  /// configured number not in the list is restored to its pre-app webhook
  /// config. Runs server-side (functions/src/twilio.ts configureSelectedNumbers).
  Future<void> configureNumbers(List<String> selectedSids) async {
    try {
      await _firebaseFunctions.httpsCallable('twilioConfigureNumbers').call({
        'accountSid': accountSid,
        'authToken': authToken,
        'selectedSids': selectedSids,
      });
    } catch (e) {
      debugPrint('Error configuring numbers: $e');
      // No "Failed to ..." prefix here: the caller (Settings) already adds
      // its own "Failed to update number configuration: ..." wrapper.
      throw _TwilioApiException(describeTwilioError(e));
    }
  }

  Future<void> _reregisterForNewNumbers(List<String> numbers) async {
    final known = _storageService.getKnownPhoneNumbers(accountSid);
    await _storageService.setKnownPhoneNumbers(accountSid, numbers);
    if (known.isEmpty) return;

    final hasNewNumber = numbers.any((number) => !known.contains(number));
    if (!hasNewNumber) return;

    await _register();
    await _storageService.setLastVoiceRegistration(accountSid, DateTime.now());
  }

  /// Fetches a page of calls for this account from the Twilio REST API, mapped
  /// to [PhoneCall]s (newest-first) and scoped to the currently selected
  /// outgoing number (dropping calls placed/received on any of the account's
  /// other numbers). Pass [pageUrl] (a [CallHistoryPage.nextPageUrl] from a
  /// previous call) to fetch the following page; omit it for the first page,
  /// where [pageSize] caps the page length (Twilio's max is 1000).
  ///
  /// The scoping filter runs after the fetch (Twilio's List Call resource has
  /// no "either To or From" filter), so a returned page can hold fewer than
  /// [pageSize] calls even when more pages remain — same tradeoff as the
  /// existing client-leg filtering below.
  /// https://www.twilio.com/docs/voice/api/call-resource#read-multiple-call-resources
  Future<CallHistoryPage> getCallHistory({int pageSize = 50, String? pageUrl}) async {
    try {
      final response = pageUrl != null
          ? await _dio.get(pageUrl)
          : await _dio.get('/Calls.json', queryParameters: {'PageSize': pageSize});
      final legs =
          (response.data['calls'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();

      // Each call here is two legs (see the TwiML in functions/src/twilio.ts):
      // an SDK <Client> leg and the matching PSTN leg. Index the child leg by
      // its parent's SID so an inbound call can read the <Client> leg's status —
      // that reveals whether the app actually answered (the inbound PSTN leg
      // itself reports `completed` either way, because the TwiML always runs).
      final childByParent = <String, Map<String, dynamic>>{};
      for (final leg in legs) {
        final parent = leg['parent_call_sid'] as String?;
        if (parent != null) childByParent[parent] = leg;
      }

      // Keep only the PSTN leg by dropping any leg whose endpoint is a `client:`
      // identity. What remains is exactly one leg per call with the real number
      // and the correct direction:
      //  - outgoing -> the outbound-dial leg (to = destination)
      //  - incoming -> the inbound leg (from = caller); its <Client> child leg
      //    (childByParent[sid]) tells us if it was answered or missed.
      final calls = legs
          .where((json) => !_isClientLeg(json))
          .map<PhoneCall>(
              (json) => _callFromTwilio(json, childByParent[json['sid']]))
          .where(_matchesCurrentNumber)
          .toList();

      // Twilio gives a relative path (host-rooted) for the next page, or null on
      // the last page. Make it absolute so it can be passed straight back in.
      final nextUri = response.data['next_page_uri'] as String?;
      final nextPageUrl = (nextUri != null && nextUri.isNotEmpty)
          ? 'https://api.twilio.com$nextUri'
          : null;

      return CallHistoryPage(calls: calls, nextPageUrl: nextPageUrl);
    } catch (e) {
      debugPrint('Error fetching call history: $e');
      // No "Failed to ..." prefix here: the caller (Call history) already adds
      // its own "Failed to load call history: ..." wrapper around this.
      throw _TwilioApiException(describeTwilioError(e));
    }
  }

  /// Whether [call]'s [PhoneCall.localNumber] is the currently selected
  /// outgoing number — or true unconditionally if that number isn't resolved
  /// yet, so history isn't hidden while startup is still in flight.
  bool _matchesCurrentNumber(PhoneCall call) {
    final current = currentPhoneNumber;
    return current == null || current.isEmpty || call.localNumber == current;
  }

  /// Whether [message]'s [Message.localNumber] is the currently selected
  /// outgoing number — see [_matchesCurrentNumber].
  bool _matchesCurrentNumberMessage(Message message) {
    final current = currentPhoneNumber;
    return current == null || current.isEmpty || message.localNumber == current;
  }

  /// A "client leg" is the Voice SDK side of the call (the app endpoint),
  /// identified by a `client:` From/To. The other leg carries the real PSTN
  /// number, so these are dropped to avoid duplicate/mislabelled entries.
  bool _isClientLeg(Map<String, dynamic> json) {
    final from = (json['from'] as String?) ?? '';
    final to = (json['to'] as String?) ?? '';
    return from.startsWith('client:') || to.startsWith('client:');
  }

  /// Maps a kept PSTN leg to a [PhoneCall]. [childLeg] is the paired SDK
  /// `<Client>` leg (only present/relevant for inbound calls), used to tell
  /// answered from missed.
  PhoneCall _callFromTwilio(
      Map<String, dynamic> json, Map<String, dynamic>? childLeg) {
    // Twilio direction is 'inbound' for incoming, 'outbound-dial'/'outbound-api'
    // for outgoing.
    final direction = (json['direction'] as String?) ?? '';
    final isIncoming = direction.startsWith('inbound');
    final from = (json['from'] as String?) ?? '';
    final to = (json['to'] as String?) ?? '';

    // Store the remote party: the caller on inbound, the callee on outbound.
    final remote = isIncoming ? from : to;
    // ...and the account's own number: the other side of that same leg.
    final local = isIncoming ? to : from;

    // duration comes back as a string of whole seconds (null while in progress).
    final legDuration = int.tryParse('${json['duration'] ?? ''}') ?? 0;

    final timestamp =
        _parseTwilioDate(json['start_time'] ?? json['date_created']) ??
            DateTime.now();

    bool isMissed = false;
    int duration = legDuration;
    if (isIncoming) {
      if (childLeg != null) {
        // The <Client> leg connected only if its status is 'completed'.
        final childStatus = (childLeg['status'] as String?) ?? '';
        isMissed = childStatus != 'completed';
        // Use the client leg's talk time as the real conversation duration.
        if (isMissed) {
          duration = 0;
        } else {
          duration = int.tryParse('${childLeg['duration'] ?? ''}') ?? legDuration;
        }
      } else {
        // No paired leg in this page: fall back to the inbound leg's status.
        final status = (json['status'] as String?) ?? '';
        isMissed = status == 'no-answer' ||
            status == 'busy' ||
            status == 'canceled' ||
            status == 'failed';
        if (isMissed) duration = 0;
      }
    }

    return PhoneCall(
      id: (json['sid'] as String?) ?? '',
      phoneNumber: remote,
      timestamp: timestamp,
      isIncoming: isIncoming,
      isMissed: isMissed,
      duration: duration,
      localNumber: local,
    );
  }

  /// Parses a Twilio timestamp into local time. Twilio uses RFC 2822
  /// (e.g. "Tue, 10 Aug 2021 01:02:03 +0000", always UTC); falls back to ISO
  /// 8601 just in case.
  DateTime? _parseTwilioDate(dynamic value) {
    if (value == null) return null;
    final s = value.toString();
    try {
      return DateTime.parse(s).toLocal();
    } catch (_) {/* not ISO 8601; try RFC 2822 below */}
    try {
      final cleaned = s.replaceAll(RegExp(r'\s*[+-]\d{4}$'), '').trim();
      return DateFormat('EEE, d MMM yyyy HH:mm:ss', 'en_US')
          .parseUtc(cleaned)
          .toLocal();
    } catch (e) {
      debugPrint('Could not parse Twilio date "$s": $e');
      return null;
    }
  }

  // Make a phone call
  Future<bool?> makeCall(String to) async {
    try {
      await ensureCurrentPhoneNumberResolved();

      // The native side places the call by starting a ConnectionService intent
      // that just returns false — with no explanation — if any permission is
      // missing. Check for that explicitly so a denial surfaces as an
      // actionable message instead of a generic "could not start call".
      final missingPermissions = await _ensureCallPermissions();
      if (missingPermissions.isNotEmpty) {
        throw Exception(
          '${missingPermissions.join(", ")} permission not granted. Please '
          'grant it in system Settings > Apps, then try again.',
        );
      }

      // Re-attempt registration here too: the startup call in
      // _ensurePhoneAccount() silently skips registering if the phone
      // permissions weren't granted yet (or otherwise fails silently), which
      // would otherwise leave no account at all for the user to pick — the
      // "Calling accounts" screen opens below but is simply empty.
      final missingPhoneAccountPermissions = await _ensurePhoneAccountPermissions();
      if (missingPhoneAccountPermissions.isNotEmpty) {
        throw Exception(
          '${missingPhoneAccountPermissions.join(", ")} permission not granted. Please '
          'grant it in system Settings > Apps, then try again.',
        );
      }
      await TwilioVoicePlatform.instance.registerPhoneAccount();

      if (!await TwilioVoicePlatform.instance.isPhoneAccountEnabled()) {
        await TwilioVoicePlatform.instance.openPhoneAccountSettings();
        throw Exception(
          'Calling account is not enabled. Please enable "twilio_phone" under '
          'Calling accounts in Settings, then try again.',
        );
      }

      // Refresh the access token + registration before dialing (tokens are short-lived).
      final accessToken = await _accessToken();
      final deviceToken = await FirebaseMessaging.instance.getToken();
      await TwilioVoicePlatform.instance.setTokens(accessToken: accessToken, deviceToken: deviceToken);

      final toPhoneNumberWithDialCode = PhoneNumber.fromString(to).getPhoneWithDialCode(PhoneNumber.fromString(currentPhoneNumber ?? ''));
      return TwilioVoicePlatform.instance.call.place(
        from: currentPhoneNumber ?? '',
        to: toPhoneNumberWithDialCode,
      );
    } on SubscriptionExpiredException {
      rethrow;
    } catch (e, stackTrace) {
      debugPrint('Error making call: $e');
      debugPrintStack(stackTrace: stackTrace);
      // No "Failed to ..." prefix here: the caller (Home) already adds its own
      // "Failed to make call: ..." wrapper around this.
      throw _TwilioApiException(describeTwilioError(e));
    }
  }

  // Send an SMS message
  Future<Message> sendMessage(String to, String body) async {
    try {
      await ensureCurrentPhoneNumberResolved();
      final response = await _dio.post(
        '/Messages.json',
        data: {'To': to, 'From': currentPhoneNumber ?? '', 'Body': body},
        options: Options(contentType: 'application/x-www-form-urlencoded'),
      );

      // Use Twilio's own SID so this message de-dupes against the copy that
      // comes back on the next history fetch.
      final sid = response.data is Map ? response.data['sid'] as String? : null;
      return Message(
        id: sid ?? UniqueKey().toString(),
        phoneNumber: to,
        content: body,
        timestamp: DateTime.now(),
        isIncoming: false,
        localNumber: currentPhoneNumber ?? '',
      );
    } catch (e) {
      debugPrint('Error sending message: $e');
      // No "Failed to ..." prefix here: the caller (Messages) already adds its
      // own "Failed to send message: ..." wrapper around this.
      throw _TwilioApiException(describeTwilioError(e));
    }
  }

  /// Fetches a page of messages for this account from the Twilio REST API,
  /// mapped to [Message]s (newest-first) and scoped to the currently selected
  /// outgoing number (dropping messages sent/received on any of the account's
  /// other numbers). Pass [pageUrl] (a [MessagePage.nextPageUrl]) to fetch the
  /// following page; omit it for the first page, where [pageSize] caps the
  /// page length (Twilio's max is 1000).
  ///
  /// As with [getCallHistory], the scoping filter runs after the fetch, so a
  /// returned page can hold fewer than [pageSize] messages even when more
  /// pages remain.
  /// https://www.twilio.com/docs/sms/api/message-resource#read-multiple-message-resources
  Future<MessagePage> getMessages({int pageSize = 50, String? pageUrl}) async {
    try {
      final response = pageUrl != null
          ? await _dio.get(pageUrl)
          : await _dio.get('/Messages.json',
              queryParameters: {'PageSize': pageSize});
      final raw = (response.data['messages'] as List<dynamic>? ?? [])
          .cast<Map<String, dynamic>>();
      final messages = (await Future.wait(raw.map(_messageFromTwilio)))
          .where(_matchesCurrentNumberMessage)
          .toList();

      final nextUri = response.data['next_page_uri'] as String?;
      final nextPageUrl = (nextUri != null && nextUri.isNotEmpty)
          ? 'https://api.twilio.com$nextUri'
          : null;

      return MessagePage(messages: messages, nextPageUrl: nextPageUrl);
    } catch (e) {
      debugPrint('Error fetching messages: $e');
      // No "Failed to ..." prefix here: the caller (Messages) already adds its
      // own "Failed to load messages: ..." wrapper around this.
      throw _TwilioApiException(describeTwilioError(e));
    }
  }

  /// Permanently deletes a message from Twilio — its body and any MMS media —
  /// via `DELETE /Messages/{Sid}.json`. This is irreversible and account-wide:
  /// the message vanishes from every device sharing this Twilio account and
  /// from the Twilio console/logs, not just this app's cache. Twilio only
  /// allows deleting messages in a terminal state (delivered/received/failed/
  /// undelivered); inbound spam always qualifies, but an outbound message
  /// still in flight is rejected with a 409, surfaced here like any other
  /// Twilio error.
  /// https://www.twilio.com/docs/sms/api/message-resource#delete-a-message-resource
  Future<void> deleteMessage(String sid) async {
    try {
      await _dio.delete('/Messages/$sid.json');
    } catch (e) {
      debugPrint('Error deleting message $sid: $e');
      // No "Failed to ..." prefix here: the caller (Messages) already adds its
      // own "Failed to delete message: ..." wrapper around this.
      throw _TwilioApiException(describeTwilioError(e));
    }
  }

  /// Deletes every message in [sids] from Twilio (see [deleteMessage]), used to
  /// wipe a whole spam conversation at once. Runs the deletes sequentially so a
  /// long thread doesn't fire a burst of concurrent DELETEs at the REST API,
  /// and — unlike [deleteMessage] — never throws: it reports which SIDs were
  /// removed alongside the first error, so the caller can prune the deleted
  /// ones from its cache even on a partial failure.
  Future<BulkDeleteResult> deleteMessages(Iterable<String> sids) async {
    final deleted = <String>[];
    for (final sid in sids) {
      try {
        await _dio.delete('/Messages/$sid.json');
        deleted.add(sid);
      } catch (e) {
        debugPrint('Error deleting message $sid: $e');
        return BulkDeleteResult(deleted: deleted, error: describeTwilioError(e));
      }
    }
    return BulkDeleteResult(deleted: deleted);
  }

  Future<Message> _messageFromTwilio(Map<String, dynamic> json) async {
    final direction = (json['direction'] as String?) ?? '';
    final isIncoming = direction == 'inbound';
    final from = (json['from'] as String?) ?? '';
    final to = (json['to'] as String?) ?? '';
    // The remote party is the other end of the thread.
    final remote = isIncoming ? from : to;
    // ...and the account's own number: the other side of that same message.
    final local = isIncoming ? to : from;
    final timestamp =
        _parseTwilioDate(json['date_sent'] ?? json['date_created']) ??
            DateTime.now();
    final sid = (json['sid'] as String?) ?? '';
    final numMedia = int.tryParse('${json['num_media'] ?? '0'}') ?? 0;
    final media = numMedia > 0 ? await _fetchMedia(sid) : <MessageMedia>[];
    final body = (json['body'] as String?) ?? '';
    // Some carriers fail to resolve an MMS notification indication into a
    // real MMS before it reaches Twilio, so Twilio hands us the raw PDU as
    // `body` with num_media == 0. We just show a placeholder for it (see
    // _isMmsNotificationIndication) rather than actually retrieving the
    // MMS, since that would require a separate pipeline from everything
    // else in this file: the PDU's X-Mms-Content-Location URL points at
    // the sending carrier's MMSC, which typically only accepts requests
    // from that carrier's own mobile-data network (source-IP restricted),
    // not from Twilio's servers or this app's normal internet connection.
    // Properly supporting this would mean fetching it out-of-band — e.g.
    // a device on that carrier's SIM/APN relaying the download to a
    // backend — rather than anything reachable from this REST client.
    return Message(
      id: sid,
      phoneNumber: remote,
      content:
          media.isEmpty && _isMmsNotificationIndication(body)
              ? 'MMS message (attachment unavailable)'
              : body,
      timestamp: timestamp,
      isIncoming: isIncoming,
      media: media,
      localNumber: local,
    );
  }

  /// Some carriers deliver an MMS "notification indication" (a binary WAP
  /// Push PDU pointing a handset at an MMSC URL) over the SMS bearer without
  /// ever resolving it into a real MMS with media. Twilio then passes that
  /// binary PDU straight through as the message body, which renders as
  /// mojibake since it's not actually text. The content-type string is
  /// embedded in the PDU as plain ASCII, so it's a reliable marker.
  bool _isMmsNotificationIndication(String body) =>
      body.contains('application/vnd.wap.mms-message');

  /// Fetches the Media subresource for an MMS message and builds the
  /// authenticated URL for each attachment (the Media resource itself, not
  /// its .json listing, serves the raw file).
  /// https://www.twilio.com/docs/sms/api/media-resource#read-multiple-media-resources
  Future<List<MessageMedia>> _fetchMedia(String messageSid) async {
    try {
      final response = await _dio.get('/Messages/$messageSid/Media.json');
      final items = (response.data['media_list'] as List<dynamic>? ?? [])
          .cast<Map<String, dynamic>>();
      return items.map((item) {
        final mediaSid = item['sid'] as String;
        final contentType =
            (item['content_type'] as String?) ?? 'application/octet-stream';
        return MessageMedia(
          url: '${_dio.options.baseUrl}/Messages/$messageSid/Media/$mediaSid',
          contentType: contentType,
        );
      }).toList();
    } catch (e) {
      debugPrint('Error fetching media for message $messageSid: $e');
      return [];
    }
  }

  // Get recent calls
  // https://www.twilio.com/docs/voice/api/call-resource#fetch-a-call-resource
  Future<List<PhoneCall>> getRecentCalls() async {
    try {
      final response = await _dio.get('/Calls.json');
      final List<PhoneCall> calls = [];

      if (response.data != null && response.data['calls'] != null) {
        for (var callData in response.data['calls']) {
          final call = PhoneCall(
            id: callData['sid'],
            phoneNumber: callData['direction'] == 'inbound'
                ? callData['from']
                : callData['to'],
            timestamp: DateTime.parse(callData['date_created']),
            isIncoming: callData['direction'] == 'inbound',
            isMissed: callData['status'] == 'no-answer',
            duration: int.tryParse(callData['duration'] ?? '0') ?? 0,
          );
          calls.add(call);
        }
      }

      return calls;
    } catch (e) {
      debugPrint('Error getting recent calls: $e');
      throw Exception('Failed to get recent calls: ${e.toString()}');
    }
  }

  // Get recent messages
  Future<List<Message>> getRecentMessages() async {
    try {
      final response = await _dio.get('/Messages.json');
      final List<Message> messages = [];

      if (response.data != null && response.data['messages'] != null) {
        for (var messageData in response.data['messages']) {
          final message = Message(
            id: messageData['sid'],
            phoneNumber: messageData['direction'] == 'inbound'
                ? messageData['from']
                : messageData['to'],
            content: messageData['body'],
            timestamp: DateTime.parse(messageData['date_created']),
            isIncoming: messageData['direction'] == 'inbound',
          );
          messages.add(message);
        }
      }

      return messages;
    } catch (e) {
      debugPrint('Error getting recent messages: $e');
      throw Exception('Failed to get recent messages: ${e.toString()}');
    }
  }

  // For receiving incoming calls and messages, you would typically need to set up a webhook
  // that Twilio can hit. For a mobile app, this would usually involve a push notification service.
  // Since we can't use system notifications per the requirements, we'll simulate this with
  // a polling mechanism in a real implementation.

  // Start polling for incoming communications (simplified for this example)
  void startPollingForIncomingCommunications() {
    // In a real implementation, this would poll Twilio's API periodically
    // or use push notifications through a backend service
    debugPrint('Started polling for incoming communications');
  }

  // Stop polling
  void stopPollingForIncomingCommunications() {
    debugPrint('Stopped polling for incoming communications');
  }
}
