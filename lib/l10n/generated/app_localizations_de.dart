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
  String get testCredentialsError =>
      'Dies sind Twilio-Testzugangsdaten, die diese App nicht verwenden kann. Geben Sie Ihre echte Account SID und Ihren Auth Token ein (ein Testkonto funktioniert auch).';

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
  String get addToContacts => 'Zu Kontakten hinzufügen';

  @override
  String get message => 'Nachricht';

  @override
  String get call => 'Anrufen';

  @override
  String get deleteFromHistory => 'Aus Verlauf löschen';

  @override
  String get deleteCallConfirm =>
      'Diesen Anruf endgültig aus Twilio löschen? Das kann nicht rückgängig gemacht werden.';

  @override
  String get callDeleted => 'Anruf gelöscht';

  @override
  String failedToDeleteCall(Object error) {
    return 'Löschen des Anrufs fehlgeschlagen: $error';
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
  String get contactsTitle => 'Kontakte';

  @override
  String get searchContactsHint => 'Kontakte suchen';

  @override
  String get noContactsFound => 'Keine Kontakte gefunden';

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
  String get delete => 'Löschen';

  @override
  String get share => 'Teilen';

  @override
  String get copy => 'Kopieren';

  @override
  String get copiedToClipboard => 'In die Zwischenablage kopiert';

  @override
  String get deleteMessage => 'Nachricht löschen';

  @override
  String get deleteConversation => 'Unterhaltung löschen';

  @override
  String get openConversation => 'Unterhaltung öffnen';

  @override
  String get deleteMessageConfirm =>
      'Diese Nachricht endgültig aus Twilio löschen? Das kann nicht rückgängig gemacht werden.';

  @override
  String deleteConversationConfirm(Object count) {
    return 'Diese gesamte Unterhaltung ($count Nachrichten) endgültig aus Twilio löschen? Das kann nicht rückgängig gemacht werden.';
  }

  @override
  String get messageDeleted => 'Nachricht gelöscht';

  @override
  String get conversationDeleted => 'Unterhaltung gelöscht';

  @override
  String failedToDeleteMessage(Object error) {
    return 'Löschen der Nachricht fehlgeschlagen: $error';
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
  String get licensePlanMonthly => 'Dialcrest-Lizenz — Monatliches Abonnement';

  @override
  String get licensePlanYearly => 'Dialcrest-Lizenz — Jährliches Abonnement';

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
  String get modeTitle => 'Modus';

  @override
  String get modeSubtitleVacation =>
      'Dieses Gerät klingelt nicht bei eingehenden Anrufen und benachrichtigt nicht über neue Nachrichten.';

  @override
  String get modeSubtitleOnline =>
      'Dieses Gerät klingelt wie gewohnt bei eingehenden Anrufen und benachrichtigt über neue Nachrichten.';

  @override
  String get onlineMode => 'Online-Modus';

  @override
  String get vacationMode => 'Urlaubsmodus';

  @override
  String get phoneNumberTitle => 'Telefonnummer';

  @override
  String get selectNumber => 'Nummer auswählen';

  @override
  String get advancedTitle => 'Erweitert';

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

  @override
  String get onboardingSkip => 'Überspringen';

  @override
  String get onboardingNext => 'Weiter';

  @override
  String get onboardingBack => 'Zurück';

  @override
  String get onboardingFinish => 'Fertig';

  @override
  String onboardingStepLabel(Object current, Object total) {
    return 'Schritt $current von $total';
  }

  @override
  String get onboardingWelcomeTitle => 'Willkommen bei Dialcrest';

  @override
  String get onboardingWelcomeBody =>
      'Richten wir alles ein, damit Sie Anrufe tätigen und empfangen können. Es dauert nur eine Minute, oder überspringen Sie es und richten Sie es später in den Einstellungen ein.';

  @override
  String get onboardingPermissionsTitle => 'Berechtigungen';

  @override
  String get onboardingPermissionsSubtitle =>
      'Dialcrest benötigt einige Berechtigungen, um Anrufe zu tätigen und Sie über eingehende Anrufe zu informieren.';

  @override
  String get onboardingGrant => 'Erlauben';

  @override
  String get onboardingGranted => 'Erteilt';

  @override
  String get onboardingOpenSettings => 'Einstellungen öffnen';

  @override
  String get onboardingMicTitle => 'Mikrofon';

  @override
  String get onboardingMicWhy =>
      'Erforderlich, damit Ihr Gesprächspartner Sie während eines Anrufs hören kann.';

  @override
  String get onboardingMicHow =>
      'Tippen Sie auf Erlauben und wählen Sie dann im Dialog Zulassen.';

  @override
  String get onboardingMicDenied =>
      'Verweigert. Öffnen Sie Einstellungen › Apps › Dialcrest › Berechtigungen und aktivieren Sie das Mikrofon.';

  @override
  String get onboardingNotificationsTitle => 'Benachrichtigungen';

  @override
  String get onboardingNotificationsWhy =>
      'Damit Sie benachrichtigt werden, wenn Sie jemand anruft oder Ihnen schreibt.';

  @override
  String get onboardingNotificationsHow =>
      'Tippen Sie auf Erlauben und wählen Sie dann Benachrichtigungen zulassen.';

  @override
  String get onboardingNotificationsDenied =>
      'Verweigert. Öffnen Sie Einstellungen › Apps › Dialcrest › Benachrichtigungen und aktivieren Sie sie.';

  @override
  String get onboardingCallingAccountTitle => 'Telefon und Anrufkonto';

  @override
  String get onboardingCallingAccountWhy =>
      'Android lässt diese App bei eingehenden Anrufen nur klingeln, wenn Dialcrest als Anrufkonto aktiviert ist.';

  @override
  String get onboardingCallingAccountStep1 =>
      'Tippen Sie unten auf Einstellungen öffnen.';

  @override
  String get onboardingCallingAccountStep2 =>
      'Suchen Sie auf dem geöffneten Bildschirm Anrufkonten nach Dialcrest.';

  @override
  String get onboardingCallingAccountStep3 =>
      'Aktivieren Sie den Schalter für Dialcrest.';

  @override
  String get onboardingCallingAccountStep4 =>
      'Drücken Sie auf Zurück, um hierher zurückzukehren. Dieser Schritt wird grün, sobald er aktiviert ist.';

  @override
  String get onboardingCallingAccountDenied =>
      'Noch nicht aktiviert. Öffnen Sie Einstellungen › Apps › Dialcrest › Anrufkonten und aktivieren Sie Dialcrest.';

  @override
  String get onboardingNumberTitle => 'Ihre Telefonnummer';

  @override
  String get onboardingNumberChooseSubtitle =>
      'Wählen Sie die Twilio-Nummer, mit der Sie Anrufe tätigen und empfangen möchten.';

  @override
  String onboardingNumberSingleInfo(Object number) {
    return 'Sie tätigen und empfangen Anrufe über $number.';
  }

  @override
  String get onboardingNumberNone =>
      'Auf Ihrem Twilio-Konto wurden keine Telefonnummern gefunden. Kaufen Sie in der Twilio Console eine sprachfähige Nummer und versuchen Sie es dann erneut.';

  @override
  String get onboardingBuyNumber => 'Twilio Console öffnen';

  @override
  String onboardingConfiguringNumber(Object number) {
    return '$number wird für eingehende Anrufe eingerichtet…';
  }

  @override
  String onboardingNumberSetupFailed(Object error) {
    return 'Die Einrichtung eingehender Anrufe konnte nicht abgeschlossen werden: $error';
  }

  @override
  String get onboardingDoneTitle => 'Alles bereit';

  @override
  String onboardingDoneBody(Object number) {
    return 'Sie können jetzt Anrufe über $number empfangen.';
  }

  @override
  String get onboardingDoneBodyNoNumber =>
      'Fügen Sie in den Einstellungen eine Telefonnummer hinzu, wenn Sie bereit sind, Anrufe zu empfangen.';

  @override
  String get onboardingDoneTitleIncomplete => 'Fast geschafft';

  @override
  String get onboardingDoneIncompleteIntro =>
      'Sie können jetzt abschließen, aber Folgendes muss noch erledigt werden, bevor Sie Anrufe tätigen und empfangen können:';

  @override
  String get onboardingDoneIncompleteHint =>
      'Gehen Sie zurück, um dies jetzt einzurichten, oder erledigen Sie es später in den Einstellungen.';

  @override
  String get chooseChannelTitle => 'Senden mit';

  @override
  String get channelSms => 'SMS';

  @override
  String get channelWhatsapp => 'WhatsApp';

  @override
  String get attachImage => 'Bild anhängen';

  @override
  String get recordVoice => 'Sprachnachricht aufnehmen';

  @override
  String get recording => 'Aufnahme…';

  @override
  String get takePhoto => 'Foto aufnehmen';

  @override
  String get chooseFromGallery => 'Aus Galerie wählen';

  @override
  String get microphonePermissionDenied =>
      'Für die Aufnahme einer Sprachnachricht ist die Mikrofonberechtigung erforderlich.';
}
