import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../services/storage_service.dart';

/// Clock-time and date-time formatting that honours the user's 24-hour vs
/// AM/PM preference (StorageService.getUse24hTime). Explicit patterns are used
/// rather than DateFormat.jm()/.add_jm() so the choice is deterministic
/// regardless of the active locale (whose default skeleton might itself be
/// 24-hour). Both read the preference via `context.watch`, so timestamps
/// rebuild live when the toggle changes.

/// "14:30" (24-hour) or "2:30 PM" (12-hour), per preference.
String formatClockTime(BuildContext context, DateTime time) {
  final use24h = context.watch<StorageService>().getUse24hTime();
  return (use24h ? DateFormat.Hm() : DateFormat('h:mm a')).format(time);
}

/// "Sep 21, 2026, 14:30" or "Sep 21, 2026, 2:30 PM", per preference.
String formatDateTime(BuildContext context, DateTime time) {
  final date = DateFormat.yMMMd().format(time);
  return '$date, ${formatClockTime(context, time)}';
}
