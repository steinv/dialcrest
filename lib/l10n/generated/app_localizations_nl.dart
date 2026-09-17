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
  String get missedSuffix => ' (Gemist)';

  @override
  String get addToContacts => 'Toevoegen aan contacten';

  @override
  String get callBack => 'Terugbellen';

  @override
  String callDetailsType(Object type) {
    return 'Type: $type';
  }

  @override
  String callDetailsTime(Object time) {
    return 'Tijd: $time';
  }

  @override
  String callDetailsDuration(Object duration) {
    return 'Duur: $duration';
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
}
