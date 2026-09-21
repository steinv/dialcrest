import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../../models/message.dart';
import '../models/call.dart';

class StorageService extends ChangeNotifier {
  late SharedPreferences _prefs;
  final FlutterSecureStorage _secureStorage = FlutterSecureStorage();

  // Twilio credentials
  String? _accountSid;
  String? _authToken;
  // Data collections
  List<PhoneCall> _calls = [];
  List<Message> _messages = [];

  // Getters
  String? get accountSid => _accountSid;
  String? get authToken => _authToken;
  List<PhoneCall> get calls => _calls;
  List<Message> get messages => _messages;

  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    await _loadCredentials();
    await _loadCalls();
    await _loadMessages();
  }

  bool hasCredentials() {
    return _accountSid != null && _authToken != null;
  }

  // Credentials management
  Future<void> _loadCredentials() async {
    try {
      _accountSid = await _secureStorage.read(key: 'twilio_account_sid');
      _authToken = await _secureStorage.read(key: 'twilio_auth_token');
    } catch (e) {
      debugPrint('Error loading credentials: $e');
    }
  }

  Future<void> saveCredentials(String accountSid, String authToken) async {
    try {
      await _secureStorage.write(key: 'twilio_account_sid', value: accountSid);
      await _secureStorage.write(key: 'twilio_auth_token', value: authToken);

      _accountSid = accountSid;
      _authToken = authToken;

      notifyListeners();
    } catch (e) {
      debugPrint('Error saving credentials: $e');
      throw Exception('Failed to save credentials');
    }
  }

  Future<void> clearCredentials() async {
    try {
      await _secureStorage.delete(key: 'twilio_account_sid');
      await _secureStorage.delete(key: 'twilio_auth_token');

      _accountSid = null;
      _authToken = null;

      notifyListeners();
    } catch (e) {
      debugPrint('Error clearing credentials: $e');
      throw Exception('Failed to clear credentials');
    }
  }

  /// When twilioRegister last completed successfully for [accountSid] on this
  /// device, or null if it's never run. Lets TwilioService skip re-running the
  /// (expensive, but idempotent) registration on every app launch.
  DateTime? getLastVoiceRegistration(String accountSid) {
    final millis = _prefs.getInt('twilio_registered_at_$accountSid');
    return millis != null ? DateTime.fromMillisecondsSinceEpoch(millis) : null;
  }

  Future<void> setLastVoiceRegistration(String accountSid, DateTime time) async {
    await _prefs.setInt('twilio_registered_at_$accountSid', time.millisecondsSinceEpoch);
  }

  /// The caller-id number the user picked for [accountSid] on this device, or
  /// null if they've never chosen one (in which case TwilioService falls back
  /// to the account's first phone number).
  String? getSelectedPhoneNumber(String accountSid) {
    return _prefs.getString('selected_phone_number_$accountSid');
  }

  Future<void> setSelectedPhoneNumber(String accountSid, String phoneNumber) async {
    await _prefs.setString('selected_phone_number_$accountSid', phoneNumber);
    notifyListeners();
  }

  /// Whether this device is in "vacation mode" for [accountSid] — paused from
  /// registering for incoming-call pushes on THIS device only. Other devices/
  /// clients sharing the same Twilio account are unaffected. Defaults to
  /// false (online / receiving calls).
  bool getVacationMode(String accountSid) {
    return _prefs.getBool('vacation_mode_$accountSid') ?? false;
  }

  Future<void> setVacationMode(String accountSid, bool vacationMode) async {
    await _prefs.setBool('vacation_mode_$accountSid', vacationMode);
    notifyListeners();
  }

  /// Whether clock times (message/call timestamps) are shown in 24-hour
  /// ("14:30") rather than 12-hour AM/PM ("2:30 PM") form. A purely local
  /// display preference — device-wide, not per-account. Defaults to 24-hour.
  bool getUse24hTime() {
    return _prefs.getBool('use_24h_time') ?? true;
  }

  Future<void> setUse24hTime(bool use24h) async {
    await _prefs.setBool('use_24h_time', use24h);
    notifyListeners();
  }

  /// Whether this device has already run the one-time "configure the caller-id
  /// number for incoming too" onboarding for [accountSid] (see
  /// TwilioService._ensureIncomingConfigured). Set once onboarding succeeds so
  /// it never re-runs — in particular so it never re-adds incoming config that
  /// an advanced user later cleared on purpose.
  bool getIncomingAutoConfigured(String accountSid) {
    return _prefs.getBool('incoming_autoconfigured_$accountSid') ?? false;
  }

  Future<void> setIncomingAutoConfigured(String accountSid, bool value) async {
    await _prefs.setBool('incoming_autoconfigured_$accountSid', value);
  }

  /// Whether the first-run onboarding wizard has been finished (or explicitly
  /// skipped) for [accountSid] on this device. Per-device — most of what the
  /// wizard drives (OS permissions, the Android calling-account toggle) is
  /// device-local — so it correctly shows again when the same account signs in
  /// on a new device. Defaults to false so a brand-new user always sees it once.
  bool getOnboardingCompleted(String accountSid) {
    return _prefs.getBool('onboarding_completed_$accountSid') ?? false;
  }

  Future<void> setOnboardingCompleted(String accountSid, bool value) async {
    await _prefs.setBool('onboarding_completed_$accountSid', value);
  }

  List<String> getKnownPhoneNumbers(String accountSid) {
    return _prefs.getStringList('known_phone_numbers_$accountSid') ?? [];
  }

  Future<void> setKnownPhoneNumbers(String accountSid, List<String> numbers) async {
    await _prefs.setStringList('known_phone_numbers_$accountSid', numbers);
  }

  /// The store entitlement (paid subscription) this device last verified, if
  /// any. Deliberately NOT keyed by accountSid: a paid subscription belongs to
  /// the person's store account, not the Twilio line, so it follows them across
  /// whatever Twilio account they sign into. `store` is 'app_store'/'play_store'
  /// and `token` is the StoreKit signedTransactionInfo / Play purchaseToken the
  /// backend re-verifies. Both null for a device that has only ever trialed.
  String? get paidEntitlementStore => _prefs.getString('paid_entitlement_store');
  String? get paidEntitlementToken => _prefs.getString('paid_entitlement_token');

  Future<void> setPaidEntitlement(String store, String token) async {
    await _prefs.setString('paid_entitlement_store', store);
    await _prefs.setString('paid_entitlement_token', token);
  }

  Future<void> clearPaidEntitlement() async {
    await _prefs.remove('paid_entitlement_store');
    await _prefs.remove('paid_entitlement_token');
  }

  // Call history management
  Future<void> _loadCalls() async {
    final callsJson = _prefs.getStringList('calls') ?? [];
    _calls = callsJson
        .map((json) => PhoneCall.fromJson(jsonDecode(json)))
        .toList();
    _calls.sort((a, b) => b.timestamp.compareTo(a.timestamp)); // newest first
  }

  Future<void> addCall(PhoneCall call) async {
    _calls.insert(0, call); // newest first
    await _saveCalls();
    notifyListeners();
  }

  /// Replaces the cached call history with a freshly fetched list (e.g. from
  /// the Twilio REST API), kept sorted newest-first. Persisted so the list can
  /// be shown instantly — and offline — on the next launch.
  Future<void> setCalls(List<PhoneCall> calls) async {
    _calls = List<PhoneCall>.from(calls)
      ..sort((a, b) => b.timestamp.compareTo(a.timestamp));
    await _saveCalls();
    notifyListeners();
  }

  Future<void> clearCallHistory() async {
    _calls.clear();
    await _saveCalls();
    notifyListeners();
  }

  Future<void> _saveCalls() async {
    final callsJson = _calls
        .map((call) => jsonEncode(call.toJson()))
        .toList();
    await _prefs.setStringList('calls', callsJson);
  }

  // Message history management
  Future<void> _loadMessages() async {
    final messagesJson = _prefs.getStringList('messages') ?? [];
    _messages = messagesJson
        .map((json) => Message.fromJson(jsonDecode(json)))
        .toList();
    _messages.sort((a, b) => b.timestamp.compareTo(a.timestamp)); // Sort by most recent
  }

  Future<void> addMessage(Message message) async {
    // Upsert by id so a message inserted live from a foreground push isn't
    // duplicated when the same message arrives again via a notification tap.
    // Real messages are keyed by their Twilio SID; synthetic ids never collide.
    _messages.removeWhere((m) => m.id == message.id);
    _messages.insert(0, message); // Add to beginning of list
    await _saveMessages();
    notifyListeners();
  }

  /// Replaces the cached messages with a freshly fetched page (e.g. from the
  /// Twilio REST API), kept sorted newest-first. Persisted so recent messages
  /// can still be shown — and grouped into conversations — when offline.
  Future<void> setMessages(List<Message> messages) async {
    _messages = List<Message>.from(messages)
      ..sort((a, b) => b.timestamp.compareTo(a.timestamp));
    await _saveMessages();
    notifyListeners();
  }

  Future<void> clearMessageHistory() async {
    _messages.clear();
    await _saveMessages();
    notifyListeners();
  }

  Future<void> _saveMessages() async {
    final messagesJson = _messages
        .map((message) => jsonEncode(message.toJson()))
        .toList();
    await _prefs.setStringList('messages', messagesJson);
  }
}