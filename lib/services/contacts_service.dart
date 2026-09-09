import 'package:flutter/foundation.dart';
import 'package:flutter_contacts/flutter_contacts.dart';

import '../models/PhoneNumber.dart';

/// A single dialable entry from the device address book.
class ContactEntry {
  final String name;
  final String number;

  ContactEntry({required this.name, required this.number});
}

/// Resolves names and provides a picker from the device's native contacts.
///
/// Replaces the app's old in-app contact store: it requests READ_CONTACTS,
/// loads the address book once, and keeps a normalized number -> name map in
/// memory for fast lookups by [getContactName]. Falls back gracefully (no
/// names, empty picker) when permission is denied.
class ContactsService extends ChangeNotifier {
  final Map<String, String> _nameByNumber = {};
  List<ContactEntry> _entries = [];

  bool _permissionGranted = false;
  bool _loaded = false;
  bool _loading = false;

  bool get permissionGranted => _permissionGranted;
  bool get loaded => _loaded;
  List<ContactEntry> get entries => List.unmodifiable(_entries);

  /// Loads the address book (requesting READ_CONTACTS if needed)
  Future<void> ensureLoaded() async {
    if (_loaded || _loading) return;
    _loading = true;
    try {
      await load();
    } finally {
      _loading = false;
    }
  }

  /// Requests permission (read-only) and (re)loads the address book. Safe to
  /// call repeatedly — e.g. on app resume to pick up edits made elsewhere.
  Future<void> load() async {
    try {
      final status =
          await FlutterContacts.permissions.request(PermissionType.read);
      _permissionGranted = status == PermissionStatus.granted ||
          status == PermissionStatus.limited;
      if (!_permissionGranted) {
        _loaded = true;
        notifyListeners();
        return;
      }

      final contacts =
          await FlutterContacts.getAll(properties: {ContactProperty.phone});
      final nameByNumber = <String, String>{};
      final entries = <ContactEntry>[];
      for (final contact in contacts) {
        final name = contact.displayName ?? '';
        if (name.isEmpty) continue;
        for (final phone in contact.phones) {
          final key = _normalize(phone.number);
          if (key.isEmpty) continue;
          nameByNumber[key] = name;
          entries.add(ContactEntry(name: name, number: phone.number));
        }
      }
      entries.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));

      _nameByNumber
        ..clear()
        ..addAll(nameByNumber);
      _entries = entries;
      _loaded = true;
      notifyListeners();
    } catch (e) {
      debugPrint('Error loading contacts: $e');
      _loaded = true;
      notifyListeners();
    }
  }

  /// Returns the contact name for [number], or null if there is no match (or no
  /// permission). Matching ignores formatting / country-prefix differences.
  String? getContactName(String number) {
    final key = _normalize(number);
    if (key.isEmpty) return null;
    return _nameByNumber[key];
  }

  /// Filters the address book by name or number for the new-conversation picker.
  List<ContactEntry> search(String query) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return entries;
    return _entries
        .where((e) =>
            e.name.toLowerCase().contains(q) ||
            e.number.toLowerCase().contains(q))
        .toList();
  }

  /// Filters the address book for the dial pad, where [digits] is whatever the
  /// user has typed so far (e.g. "047"). Matches when a contact's number
  /// contains [digits] anywhere in its national significant number — not just
  /// as a prefix — so e.g. 0478394317, +32478394317 and 0032478394317 are all
  /// treated as the same number regardless of which form was typed or stored.
  ///
  /// A trunk/country prefix typed on its own (e.g. "0") normalizes away to
  /// nothing significant — that's not a filter yet, so every contact matches,
  /// same as an empty query would in [search].
  List<ContactEntry> searchByDigits(String digits) {
    if (digits.isEmpty) return const [];
    final q = _nationalDigits(digits);
    if (q.isEmpty) return entries;
    return _entries.where((e) => _nationalDigits(e.number).contains(q)).toList();
  }

  /// Opens the OS "add contact" screen, pre-filled with [number].
  Future<void> openAddContact(String number) async {
    try {
      await FlutterContacts.native
          .showCreator(contact: Contact(phones: [Phone(number: number)]));
      // The user may have just saved a new contact; refresh the cache.
      await load();
    } catch (e) {
      debugPrint('Error opening add-contact screen: $e');
    }
  }

  /// Reduces a number to its trailing significant digits so values that differ
  /// only in formatting or country/trunk prefix still match.
  String _normalize(String number) {
    final digits = number.replaceAll(RegExp(r'\D'), '');
    return digits.length > 9 ? digits.substring(digits.length - 9) : digits;
  }

  /// Strips [raw] down to its digits (keeping a leading `+` if present) so
  /// [PhoneNumber.seperatePhoneAndDialCode] — the same helper used when
  /// placing a call — can recognize a "00" or "+" country-code prefix.
  String _toDialFormat(String raw) {
    final digits = raw.replaceAll(RegExp(r'\D'), '');
    return raw.trim().startsWith('+') ? '+$digits' : digits;
  }

  /// The national significant number for [raw]: its digits with any country
  /// code (+32, 0032, ...) and leading trunk "0" removed, so 0478394317,
  /// +32478394317 and 0032478394317 all collapse to "478394317".
  String _nationalDigits(String raw) {
    return PhoneNumber.seperatePhoneAndDialCode(_toDialFormat(raw))[1] ?? '';
  }
}
