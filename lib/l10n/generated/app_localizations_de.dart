// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for German (`de`).
class AppLocalizationsDe extends AppLocalizations {
  AppLocalizationsDe([String locale = 'de']) : super(locale);

  @override
  String get authSubtitle =>
      'Geben Sie Ihre Twilio-Zugangsdaten ein, um Anrufe und Nachrichten zu senden und zu empfangen.';

  @override
  String get accountSidLabel => 'Account SID';

  @override
  String get accountSidValidatorError => 'Bitte geben Sie Ihre Account SID ein';

  @override
  String get authTokenLabel => 'Auth Token';

  @override
  String get authTokenValidatorError => 'Bitte geben Sie Ihren Auth Token ein';

  @override
  String get connect => 'Verbinden';

  @override
  String get consoleHelpText =>
      'Ihre Account SID und Ihren Auth Token finden Sie in Ihrer Twilio Console.';

  @override
  String get invalidCredentialsError =>
      'Ungültige Account SID oder ungültiger Auth Token, oder Konto gesperrt. Überprüfen Sie Ihre Twilio Console und versuchen Sie es erneut.';

  @override
  String credentialsCheckError(Object error) {
    return 'Zugangsdaten konnten nicht überprüft werden (Verbindung prüfen): $error';
  }

  @override
  String get noCallHistory => 'Kein Anrufverlauf';

  @override
  String get couldNotLoadCallHistory =>
      'Anrufverlauf konnte nicht geladen werden';

  @override
  String get retry => 'Erneut versuchen';

  @override
  String failedToLoadCallHistory(Object error) {
    return 'Laden des Anrufverlaufs fehlgeschlagen: $error';
  }

  @override
  String get callTypeMissed => 'Verpasst';

  @override
  String get callTypeIncoming => 'Eingehend';

  @override
  String get callTypeOutgoing => 'Ausgehend';

  @override
  String get missedSuffix => ' (Verpasst)';

  @override
  String get addToContacts => 'Zu Kontakten hinzufügen';

  @override
  String get callBack => 'Zurückrufen';

  @override
  String callDetailsType(Object type) {
    return 'Typ: $type';
  }

  @override
  String callDetailsTime(Object time) {
    return 'Zeit: $time';
  }

  @override
  String callDetailsDuration(Object duration) {
    return 'Dauer: $duration';
  }

  @override
  String durationHoursMinutes(Object hours, Object minutes) {
    return '$hours Std $minutes Min';
  }

  @override
  String durationMinutesSeconds(Object minutes, Object seconds) {
    return '$minutes Min $seconds Sek';
  }

  @override
  String durationSeconds(Object seconds) {
    return '$seconds Sek';
  }

  @override
  String couldNotStartCall(Object number) {
    return 'Anruf zu $number konnte nicht gestartet werden';
  }

  @override
  String connectingTo(Object number) {
    return 'Verbindung zu $number wird hergestellt…';
  }

  @override
  String failedToMakeCall(Object error) {
    return 'Anruf fehlgeschlagen: $error';
  }

  @override
  String get contactsPermissionDenied =>
      'Der Zugriff auf Kontakte wurde verweigert. Kontaktnamen werden erst angezeigt, wenn er in den Systemeinstellungen > Apps erlaubt wird.';

  @override
  String failedToSwitchNumber(Object error) {
    return 'Nummer konnte nicht gewechselt werden: $error';
  }

  @override
  String get incomingCallTitle => 'Eingehender Anruf';

  @override
  String incomingCallBody(Object name) {
    return 'Von: $name';
  }

  @override
  String get newMessageTitle => 'Neue Nachricht';

  @override
  String get newConversationTitle => 'Neue Unterhaltung';

  @override
  String get phoneNumberOrContactHint => 'Telefonnummer oder Kontaktname';

  @override
  String get cancel => 'Abbrechen';

  @override
  String get start => 'Starten';

  @override
  String get newConversationTooltip => 'Neue Unterhaltung';

  @override
  String get dialerTabLabel => 'Wählen';

  @override
  String get callsTabLabel => 'Anrufe';

  @override
  String get messagesTabLabel => 'Nachrichten';

  @override
  String get settingsTabLabel => 'Einstellungen';

  @override
  String get appBarTitleCallHistory => 'Anrufverlauf';

  @override
  String get appBarTitleDefault => 'Twilio Softphone';

  @override
  String get switchOutgoingNumberTooltip => 'Ausgehende Nummer wechseln';

  @override
  String switchOutgoingNumberTooltipWithCurrent(Object number) {
    return 'Ausgehende Nummer wechseln (aktuell: $number)';
  }

  @override
  String get somethingWentWrong => 'Es ist ein Fehler aufgetreten';

  @override
  String failedToLoadMessages(Object error) {
    return 'Laden der Nachrichten fehlgeschlagen: $error';
  }

  @override
  String failedToLoadMoreMessages(Object error) {
    return 'Laden weiterer Nachrichten fehlgeschlagen: $error';
  }

  @override
  String failedToSendMessage(Object error) {
    return 'Senden der Nachricht fehlgeschlagen: $error';
  }

  @override
  String get noMessagesYet => 'Noch keine Nachrichten';

  @override
  String get couldNotLoadMessages => 'Nachrichten konnten nicht geladen werden';

  @override
  String get startAConversation => 'Unterhaltung starten';

  @override
  String get typeMessageHint => 'Nachricht eingeben...';

  @override
  String planUnavailableError(Object plan) {
    return 'Der Tarif $plan ist im Store derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.';
  }

  @override
  String couldNotLoadSubscription(Object error) {
    return 'Abonnementstatus konnte nicht geladen werden: $error';
  }

  @override
  String purchaseFailed(Object error) {
    return 'Kauf fehlgeschlagen: $error';
  }

  @override
  String get purchaseCanceled => 'Kauf abgebrochen';

  @override
  String get restorePurchases => 'Käufe wiederherstellen';

  @override
  String get purchasesRestored => 'Abo wiederhergestellt';

  @override
  String get noPurchasesToRestore =>
      'Kein aktives Abo zum Wiederherstellen gefunden';

  @override
  String failedToUpdateMode(Object error) {
    return 'Aktualisieren des Modus fehlgeschlagen: $error';
  }

  @override
  String couldNotLoadPhoneNumbers(Object error) {
    return 'Telefonnummern konnten nicht geladen werden: $error';
  }

  @override
  String failedToUpdateNumberConfig(Object error) {
    return 'Aktualisieren der Nummernkonfiguration fehlgeschlagen: $error';
  }

  @override
  String get twilioAccountError =>
      'Überprüfen Sie Ihr Twilio-Konto auf Probleme (Sperrung, Testphase-Einschränkungen, ungültige Anmeldedaten).';

  @override
  String get noInternetConnection =>
      'Keine Internetverbindung. Überprüfen Sie Ihr WLAN oder Ihre mobilen Daten und versuchen Sie es erneut.';

  @override
  String get logOut => 'Abmelden';

  @override
  String get logOutConfirmMessage =>
      'Dadurch werden Ihre Twilio Account SID und Ihr Auth Token von diesem Gerät entfernt. Sie können sich jederzeit erneut verbinden.';

  @override
  String get licenseTitle => 'Lizenz';

  @override
  String get licenseSubtitle =>
      'Ihr Dialcrest-Abonnement für dieses Twilio-Konto.';

  @override
  String get purchasingUnavailable =>
      'Käufe sind auf dieser Plattform nicht verfügbar.';

  @override
  String get trialExpired => 'Testphase abgelaufen';

  @override
  String get subscriptionExpired => 'Abonnement abgelaufen';

  @override
  String trialDaysLeft(num days) {
    String _temp0 = intl.Intl.pluralLogic(
      days,
      locale: localeName,
      other: 'Tage',
      one: 'Tag',
    );
    return 'Testphase — noch $days $_temp0';
  }

  @override
  String renewsOn(Object date) {
    return 'Verlängert sich am $date';
  }

  @override
  String expiresOnAutoRenewOff(Object date) {
    return 'Läuft am $date ab — automatische Verlängerung ist deaktiviert';
  }

  @override
  String get monthly => 'Monatlich';

  @override
  String get yearly => 'Jährlich';

  @override
  String get perMonthSuffix => '/Monat';

  @override
  String get perYearSuffix => '/Jahr';

  @override
  String get yearlyDiscountNote =>
      'Mit dem Jahresabo erhalten Sie 2 Monate kostenlos. Abonnements verlängern sich automatisch bis zur Kündigung.';

  @override
  String get modeTitle => 'Modus';

  @override
  String get modeSubtitleVacation =>
      'Dieses Gerät klingelt nicht bei eingehenden Anrufen und benachrichtigt nicht über neue Nachrichten. Andere Nutzer dieses Twilio-Kontos sind davon nicht betroffen.';

  @override
  String get modeSubtitleOnline =>
      'Dieses Gerät klingelt wie gewohnt bei eingehenden Anrufen.';

  @override
  String get onlineMode => 'Online-Modus';

  @override
  String get vacationMode => 'Urlaubsmodus';

  @override
  String get outgoingTitle => 'Ausgehend';

  @override
  String get outgoingSubtitle =>
      'Die Nummer, die als Anrufer-ID verwendet wird, wenn Sie anrufen oder eine Nachricht senden.';

  @override
  String get noPhoneNumbersFound =>
      'In diesem Twilio-Konto wurden keine Telefonnummern gefunden.';

  @override
  String get incomingTitle => 'Eingehend';

  @override
  String get incomingSubtitle =>
      'Nur markierte Nummern klingeln in dieser App.';

  @override
  String moreResults(Object count) {
    return '$count Ergebnisse · Weitere Ergebnisse';
  }

  @override
  String get audioMessage => 'Sprachnachricht';

  @override
  String get attachment => 'Anhang';
}
