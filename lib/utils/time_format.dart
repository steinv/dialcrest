import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';

/// Clock-time and date-time formatting that honours the device's 24-hour vs
/// AM/PM setting. This follows `MediaQuery.alwaysUse24HourFormat`, which
/// reflects both the locale default and the user's system-wide override
/// (Android Settings > System > Date & time > Use 24-hour format), so no
/// in-app preference is needed. Explicit patterns are used rather than
/// DateFormat.jm() so the choice tracks that flag rather than the locale's
/// own skeleton. Both read the flag via MediaQuery, so timestamps rebuild
/// live when the system setting changes.

/// "14:30" (24-hour) or "2:30 PM" (12-hour), per the device setting.
String formatClockTime(BuildContext context, DateTime time) {
  final use24h = MediaQuery.of(context).alwaysUse24HourFormat;
  return (use24h ? DateFormat.Hm() : DateFormat('h:mm a')).format(time);
}

/// "Sep 21, 2026, 14:30" or "Sep 21, 2026, 2:30 PM", per the device setting.
String formatDateTime(BuildContext context, DateTime time) {
  final date = DateFormat.yMMMd().format(time);
  return '$date, ${formatClockTime(context, time)}';
}
