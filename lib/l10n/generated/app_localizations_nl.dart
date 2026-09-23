// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Dutch Flemish (`nl`).
class AppLocalizationsNl extends AppLocalizations {
  AppLocalizationsNl([String locale = 'nl']) : super(locale);

  @override
  String get authSubtitle =>
      'Voer uw Twilio-gegevens in om te beginnen met bellen en berichten verzenden en ontvangen.';

  @override
  String get accountSidLabel => 'Account SID';

  @override
  String get accountSidValidatorError => 'Voer uw Account SID in';

  @override
  String get authTokenLabel => 'Auth Token';

  @override
  String get authTokenValidatorError => 'Voer uw Auth Token in';

  @override
  String get connect => 'Verbinden';

  @override
  String get consoleHelpText =>
      'U vindt uw Account SID en Auth Token in uw Twilio Console.';

  @override
  String get invalidCredentialsError =>
      'Ongeldige Account SID of Auth Token, of geschorst account. Controleer uw Twilio Console en probeer het opnieuw.';

  @override
  String get testCredentialsError =>
      'Dit zijn Twilio-testgegevens, die deze app niet kan gebruiken. Voer uw echte Account SID en Auth Token in (een proefaccount werkt ook).';

  @override
  String credentialsCheckError(Object error) {
    return 'Kon gegevens niet verifiëren (controleer uw verbinding): $error';
  }

  @override
  String get noCallHistory => 'Geen oproepgeschiedenis';

  @override
  String get couldNotLoadCallHistory => 'Kan oproepgeschiedenis niet laden';

  @override
  String get retry => 'Opnieuw proberen';

  @override
  String failedToLoadCallHistory(Object error) {
    return 'Laden van oproepgeschiedenis mislukt: $error';
  }

  @override
  String get callTypeMissed => 'Gemist';

  @override
  String get callTypeIncoming => 'Inkomend';

  @override
  String get callTypeOutgoing => 'Uitgaand';

  @override
  String get addToContacts => 'Toevoegen aan contacten';

  @override
  String get message => 'Bericht';

  @override
  String get call => 'Bellen';

  @override
  String get deleteFromHistory => 'Uit geschiedenis verwijderen';

  @override
  String get deleteCallConfirm =>
      'Dit gesprek definitief verwijderen uit Twilio? Dit kan niet ongedaan worden gemaakt.';

  @override
  String get callDeleted => 'Gesprek verwijderd';

  @override
  String failedToDeleteCall(Object error) {
    return 'Verwijderen van gesprek mislukt: $error';
  }

  @override
  String durationHoursMinutes(Object hours, Object minutes) {
    return '${hours}u ${minutes}m';
  }

  @override
  String durationMinutesSeconds(Object minutes, Object seconds) {
    return '${minutes}m ${seconds}s';
  }

  @override
  String durationSeconds(Object seconds) {
    return '${seconds}s';
  }

  @override
  String couldNotStartCall(Object number) {
    return 'Kon geen oproep starten naar $number';
  }

  @override
  String connectingTo(Object number) {
    return 'Verbinden met $number…';
  }

  @override
  String failedToMakeCall(Object error) {
    return 'Bellen mislukt: $error';
  }

  @override
  String get contactsPermissionDenied =>
      'Toegang tot contacten is geweigerd. Contactnamen worden niet weergegeven totdat dit is toegestaan via Instellingen > Apps.';

  @override
  String failedToSwitchNumber(Object error) {
    return 'Nummer wisselen mislukt: $error';
  }

  @override
  String get incomingCallTitle => 'Inkomende oproep';

  @override
  String incomingCallBody(Object name) {
    return 'Van: $name';
  }

  @override
  String get newMessageTitle => 'Nieuw bericht';

  @override
  String get newConversationTitle => 'Nieuw gesprek';

  @override
  String get phoneNumberOrContactHint => 'Telefoonnummer of contactnaam';

  @override
  String get cancel => 'Annuleren';

  @override
  String get start => 'Starten';

  @override
  String get newConversationTooltip => 'Nieuw gesprek';

  @override
  String get contactsTitle => 'Contacten';

  @override
  String get searchContactsHint => 'Contacten zoeken';

  @override
  String get noContactsFound => 'Geen contacten gevonden';

  @override
  String get dialerTabLabel => 'Kiezer';

  @override
  String get callsTabLabel => 'Oproepen';

  @override
  String get messagesTabLabel => 'Berichten';

  @override
  String get settingsTabLabel => 'Instellingen';

  @override
  String get appBarTitleCallHistory => 'Oproepgeschiedenis';

  @override
  String get appBarTitleDefault => 'Twilio Softphone';

  @override
  String get switchOutgoingNumberTooltip => 'Uitgaand nummer wisselen';

  @override
  String switchOutgoingNumberTooltipWithCurrent(Object number) {
    return 'Uitgaand nummer wisselen (huidig: $number)';
  }

  @override
  String get somethingWentWrong => 'Er is iets misgegaan';

  @override
  String failedToLoadMessages(Object error) {
    return 'Laden van berichten mislukt: $error';
  }

  @override
  String failedToLoadMoreMessages(Object error) {
    return 'Laden van meer berichten mislukt: $error';
  }

  @override
  String failedToSendMessage(Object error) {
    return 'Versturen van bericht mislukt: $error';
  }

  @override
  String get delete => 'Verwijderen';

  @override
  String get share => 'Delen';

  @override
  String get copy => 'Kopiëren';

  @override
  String get copiedToClipboard => 'Gekopieerd naar klembord';

  @override
  String get deleteMessage => 'Bericht verwijderen';

  @override
  String get deleteConversation => 'Gesprek verwijderen';

  @override
  String get openConversation => 'Gesprek openen';

  @override
  String get deleteMessageConfirm =>
      'Dit bericht definitief verwijderen uit Twilio? Dit kan niet ongedaan worden gemaakt.';

  @override
  String deleteConversationConfirm(Object count) {
    return 'Dit hele gesprek ($count berichten) definitief verwijderen uit Twilio? Dit kan niet ongedaan worden gemaakt.';
  }

  @override
  String get messageDeleted => 'Bericht verwijderd';

  @override
  String get conversationDeleted => 'Gesprek verwijderd';

  @override
  String failedToDeleteMessage(Object error) {
    return 'Verwijderen van bericht mislukt: $error';
  }

  @override
  String get noMessagesYet => 'Nog geen berichten';

  @override
  String get couldNotLoadMessages => 'Kan berichten niet laden';

  @override
  String get startAConversation => 'Start een gesprek';

  @override
  String get typeMessageHint => 'Typ een bericht...';

  @override
  String planUnavailableError(Object plan) {
    return 'Het abonnement $plan is momenteel niet beschikbaar in de store. Probeer het later opnieuw.';
  }

  @override
  String couldNotLoadSubscription(Object error) {
    return 'Kan abonnementsstatus niet laden: $error';
  }

  @override
  String purchaseFailed(Object error) {
    return 'Aankoop mislukt: $error';
  }

  @override
  String get purchaseCanceled => 'Aankoop geannuleerd';

  @override
  String get restorePurchases => 'Aankopen herstellen';

  @override
  String get purchasesRestored => 'Abonnement hersteld';

  @override
  String get noPurchasesToRestore =>
      'Geen actief abonnement gevonden om te herstellen';

  @override
  String failedToUpdateMode(Object error) {
    return 'Bijwerken van modus mislukt: $error';
  }

  @override
  String couldNotLoadPhoneNumbers(Object error) {
    return 'Kan telefoonnummers niet laden: $error';
  }

  @override
  String failedToUpdateNumberConfig(Object error) {
    return 'Bijwerken van nummerconfiguratie mislukt: $error';
  }

  @override
  String get twilioAccountError =>
      'Controleer je Twilio-account op problemen (geschorst, proefbeperkingen, ongeldige inloggegevens).';

  @override
  String get noInternetConnection =>
      'Geen internetverbinding. Controleer je wifi of mobiele data en probeer het opnieuw.';

  @override
  String get logOut => 'Uitloggen';

  @override
  String get logOutConfirmMessage =>
      'Hiermee worden uw Twilio Account SID en Auth Token van dit apparaat verwijderd. U kunt op elk moment opnieuw verbinden.';

  @override
  String get licenseTitle => 'Licentie';

  @override
  String get licensePlanMonthly =>
      'Dialcrest-licentie — Maandelijks abonnement';

  @override
  String get licensePlanYearly => 'Dialcrest-licentie — Jaarlijks abonnement';

  @override
  String get purchasingUnavailable =>
      'Aankopen zijn niet beschikbaar op dit platform.';

  @override
  String get trialExpired => 'Proefperiode verlopen';

  @override
  String get subscriptionExpired => 'Abonnement verlopen';

  @override
  String trialDaysLeft(num days) {
    String _temp0 = intl.Intl.pluralLogic(
      days,
      locale: localeName,
      other: 'dagen',
      one: 'dag',
    );
    return 'Proefperiode — nog $days $_temp0';
  }

  @override
  String renewsOn(Object date) {
    return 'Wordt verlengd op $date';
  }

  @override
  String expiresOnAutoRenewOff(Object date) {
    return 'Verloopt op $date — automatisch verlengen is uit';
  }

  @override
  String get monthly => 'Maandelijks';

  @override
  String get yearly => 'Jaarlijks';

  @override
  String get perMonthSuffix => '/maand';

  @override
  String get perYearSuffix => '/jaar';

  @override
  String get modeTitle => 'Modus';

  @override
  String get modeSubtitleVacation =>
      'Dit apparaat gaat niet over bij inkomende oproepen en meldt geen nieuwe berichten.';

  @override
  String get modeSubtitleOnline =>
      'Dit apparaat gaat normaal over bij inkomende oproepen en meldt nieuwe berichten.';

  @override
  String get onlineMode => 'Online modus';

  @override
  String get vacationMode => 'Vakantiemodus';

  @override
  String get phoneNumberTitle => 'Telefoonnummer';

  @override
  String get selectNumber => 'Kies een nummer';

  @override
  String get advancedTitle => 'Geavanceerd';

  @override
  String get outgoingTitle => 'Uitgaand';

  @override
  String get outgoingSubtitle =>
      'Het nummer dat wordt gebruikt als beller-ID wanneer u belt of een bericht verstuurt.';

  @override
  String get noPhoneNumbersFound =>
      'Geen telefoonnummers gevonden op dit Twilio-account.';

  @override
  String get incomingTitle => 'Inkomend';

  @override
  String get incomingSubtitle =>
      'Alleen aangevinkte nummers gaan over in deze app.';

  @override
  String moreResults(Object count) {
    return '$count resultaten · Meer resultaten';
  }

  @override
  String get audioMessage => 'Audiobericht';

  @override
  String get attachment => 'Bijlage';

  @override
  String get onboardingSkip => 'Overslaan';

  @override
  String get onboardingNext => 'Volgende';

  @override
  String get onboardingBack => 'Terug';

  @override
  String get onboardingFinish => 'Voltooien';

  @override
  String onboardingStepLabel(Object current, Object total) {
    return 'Stap $current van $total';
  }

  @override
  String get onboardingWelcomeTitle => 'Welkom bij Dialcrest';

  @override
  String get onboardingWelcomeBody =>
      'Laten we alles instellen zodat u kunt bellen en gebeld worden. Het duurt maar een minuut, of sla het over en stel het later in bij Instellingen.';

  @override
  String get onboardingPermissionsTitle => 'Machtigingen';

  @override
  String get onboardingPermissionsSubtitle =>
      'Dialcrest heeft een paar machtigingen nodig om te bellen en u te waarschuwen bij inkomende oproepen.';

  @override
  String get onboardingGrant => 'Toestaan';

  @override
  String get onboardingGranted => 'Verleend';

  @override
  String get onboardingOpenSettings => 'Instellingen openen';

  @override
  String get onboardingMicTitle => 'Microfoon';

  @override
  String get onboardingMicWhy =>
      'Nodig zodat de ander u tijdens een gesprek kan horen.';

  @override
  String get onboardingMicHow =>
      'Tik op Toestaan en kies daarna Toestaan in het venster dat verschijnt.';

  @override
  String get onboardingMicDenied =>
      'Geweigerd. Open Instellingen › Apps › Dialcrest › Machtigingen en schakel Microfoon in.';

  @override
  String get onboardingNotificationsTitle => 'Meldingen';

  @override
  String get onboardingNotificationsWhy =>
      'Zodat u wordt gewaarschuwd wanneer iemand u belt of een bericht stuurt.';

  @override
  String get onboardingNotificationsHow =>
      'Tik op Toestaan en kies daarna Meldingen toestaan in het venster.';

  @override
  String get onboardingNotificationsDenied =>
      'Geweigerd. Open Instellingen › Apps › Dialcrest › Meldingen en schakel ze in.';

  @override
  String get onboardingCallingAccountTitle => 'Telefoon en belaccount';

  @override
  String get onboardingCallingAccountWhy =>
      'Android laat deze app alleen overgaan bij inkomende oproepen wanneer Dialcrest is ingeschakeld als belaccount.';

  @override
  String get onboardingCallingAccountStep1 =>
      'Tik hieronder op Instellingen openen.';

  @override
  String get onboardingCallingAccountStep2 =>
      'Zoek Dialcrest op het scherm Belaccounts dat wordt geopend.';

  @override
  String get onboardingCallingAccountStep3 =>
      'Zet de schakelaar voor Dialcrest aan.';

  @override
  String get onboardingCallingAccountStep4 =>
      'Druk op terug om hierheen terug te keren. Deze stap wordt groen zodra hij aan staat.';

  @override
  String get onboardingCallingAccountDenied =>
      'Nog niet ingeschakeld. Open Instellingen › Apps › Dialcrest › Belaccounts en zet Dialcrest aan.';

  @override
  String get onboardingNumberTitle => 'Uw telefoonnummer';

  @override
  String get onboardingNumberChooseSubtitle =>
      'Kies het Twilio-nummer dat u gebruikt om te bellen en gebeld te worden.';

  @override
  String onboardingNumberSingleInfo(Object number) {
    return 'U belt en wordt gebeld op $number.';
  }

  @override
  String get onboardingNumberNone =>
      'Er zijn geen telefoonnummers gevonden op uw Twilio-account. Koop een nummer met spraakondersteuning in de Twilio Console en probeer het daarna opnieuw.';

  @override
  String get onboardingBuyNumber => 'Twilio Console openen';

  @override
  String onboardingConfiguringNumber(Object number) {
    return '$number instellen voor inkomende oproepen…';
  }

  @override
  String onboardingNumberSetupFailed(Object error) {
    return 'Kon het instellen van inkomende oproepen niet voltooien: $error';
  }

  @override
  String get onboardingDoneTitle => 'Alles is klaar';

  @override
  String onboardingDoneBody(Object number) {
    return 'U kunt nu gebeld worden op $number.';
  }

  @override
  String get onboardingDoneBodyNoNumber =>
      'Voeg een telefoonnummer toe bij Instellingen wanneer u klaar bent om oproepen te ontvangen.';

  @override
  String get onboardingDoneTitleIncomplete => 'Bijna klaar';

  @override
  String get onboardingDoneIncompleteIntro =>
      'U kunt nu voltooien, maar het volgende heeft nog aandacht nodig voordat u kunt bellen en gebeld worden:';

  @override
  String get onboardingDoneIncompleteHint =>
      'Ga terug om dit nu in te stellen, of doe het later bij Instellingen.';
}
