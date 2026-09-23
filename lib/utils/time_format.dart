import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';

/// Clock-time and date-time formatting that honours the device's regional
/// settings. The 24-hour vs AM/PM choice follows
/// `MediaQuery.alwaysUse24HourFormat`, which reflects both the locale default
/// and the user's system-wide override (Android Settings > System > Date &
/// time > Use 24-hour format). Date order (month/day/year) and month/AM-PM
/// spellings follow the active locale, which Flutter resolves from the OS —
/// hence the explicit locale argument to DateFormat, without which intl falls
/// back to en_US. Both read from context, so timestamps rebuild live when the
/// system setting or locale changes.

/// "14:30" (24-hour) or "2:30 PM" (12-hour), per the device setting/locale.
String formatClockTime(BuildContext context, DateTime time) {
  final locale = Localizations.localeOf(context).toString();
  final use24h = MediaQuery.of(context).alwaysUse24HourFormat;
  final pattern =
      use24h ? DateFormat.Hm(locale) : DateFormat('h:mm a', locale);
  return pattern.format(time);
}

/// e.g. "Sep 21, 2026, 14:30" (en_US) or "21 sep. 2026, 14:30" (nl), per the
/// device setting/locale.
String formatDateTime(BuildContext context, DateTime time) {
  final locale = Localizations.localeOf(context).toString();
  final date = DateFormat.yMMMd(locale).format(time);
  return '$date, ${formatClockTime(context, time)}';
}
