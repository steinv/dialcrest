// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for French (`fr`).
class AppLocalizationsFr extends AppLocalizations {
  AppLocalizationsFr([String locale = 'fr']) : super(locale);

  @override
  String get authSubtitle =>
      'Saisissez vos identifiants Twilio pour commencer à passer et recevoir des appels et des messages.';

  @override
  String get accountSidLabel => 'Account SID';

  @override
  String get accountSidValidatorError => 'Veuillez saisir votre Account SID';

  @override
  String get authTokenLabel => 'Auth Token';

  @override
  String get authTokenValidatorError => 'Veuillez saisir votre Auth Token';

  @override
  String get connect => 'Connexion';

  @override
  String get consoleHelpText =>
      'Vous trouverez votre Account SID et votre Auth Token dans votre Twilio Console.';

  @override
  String get invalidCredentialsError =>
      'Account SID ou Auth Token invalide, ou compte suspendu. Vérifiez votre Twilio Console et réessayez.';

  @override
  String credentialsCheckError(Object error) {
    return 'Impossible de vérifier les identifiants (vérifiez votre connexion) : $error';
  }

  @override
  String get noCallHistory => 'Aucun historique d\'appels';

  @override
  String get couldNotLoadCallHistory =>
      'Impossible de charger l\'historique des appels';

  @override
  String get retry => 'Réessayer';

  @override
  String failedToLoadCallHistory(Object error) {
    return 'Échec du chargement de l\'historique des appels : $error';
  }

  @override
  String get callTypeMissed => 'Manqué';

  @override
  String get callTypeIncoming => 'Entrant';

  @override
  String get callTypeOutgoing => 'Sortant';

  @override
  String get missedSuffix => ' (Manqué)';

  @override
  String get addToContacts => 'Ajouter aux contacts';

  @override
  String get callBack => 'Rappeler';

  @override
  String callDetailsType(Object type) {
    return 'Type : $type';
  }

  @override
  String callDetailsTime(Object time) {
    return 'Heure : $time';
  }

  @override
  String callDetailsDuration(Object duration) {
    return 'Durée : $duration';
  }

  @override
  String durationHoursMinutes(Object hours, Object minutes) {
    return '$hours h $minutes min';
  }

  @override
  String durationMinutesSeconds(Object minutes, Object seconds) {
    return '$minutes min $seconds s';
  }

  @override
  String durationSeconds(Object seconds) {
    return '$seconds s';
  }

  @override
  String couldNotStartCall(Object number) {
    return 'Impossible de démarrer l\'appel vers $number';
  }

  @override
  String connectingTo(Object number) {
    return 'Connexion à $number…';
  }

  @override
  String failedToMakeCall(Object error) {
    return 'Échec de l\'appel : $error';
  }

  @override
  String get contactsPermissionDenied =>
      'L\'accès aux contacts a été refusé. Les noms des contacts ne s\'afficheront pas tant qu\'il n\'est pas autorisé dans Réglages > Applications.';

  @override
  String failedToSwitchNumber(Object error) {
    return 'Échec du changement de numéro : $error';
  }

  @override
  String get incomingCallTitle => 'Appel entrant';

  @override
  String incomingCallBody(Object name) {
    return 'De : $name';
  }

  @override
  String get newMessageTitle => 'Nouveau message';

  @override
  String get newConversationTitle => 'Nouvelle conversation';

  @override
  String get phoneNumberOrContactHint =>
      'Numéro de téléphone ou nom du contact';

  @override
  String get cancel => 'Annuler';

  @override
  String get start => 'Démarrer';

  @override
  String get newConversationTooltip => 'Nouvelle conversation';

  @override
  String get dialerTabLabel => 'Clavier';

  @override
  String get callsTabLabel => 'Appels';

  @override
  String get messagesTabLabel => 'Messages';

  @override
  String get settingsTabLabel => 'Réglages';

  @override
  String get appBarTitleCallHistory => 'Historique des appels';

  @override
  String get appBarTitleDefault => 'Twilio Softphone';

  @override
  String get switchOutgoingNumberTooltip => 'Changer le numéro sortant';

  @override
  String switchOutgoingNumberTooltipWithCurrent(Object number) {
    return 'Changer le numéro sortant (actuel : $number)';
  }

  @override
  String get somethingWentWrong => 'Une erreur est survenue';

  @override
  String failedToLoadMessages(Object error) {
    return 'Échec du chargement des messages : $error';
  }

  @override
  String failedToLoadMoreMessages(Object error) {
    return 'Échec du chargement d\'autres messages : $error';
  }

  @override
  String failedToSendMessage(Object error) {
    return 'Échec de l\'envoi du message : $error';
  }

  @override
  String get noMessagesYet => 'Pas encore de messages';

  @override
  String get couldNotLoadMessages => 'Impossible de charger les messages';

  @override
  String get startAConversation => 'Démarrer une conversation';

  @override
  String get typeMessageHint => 'Écrivez un message...';

  @override
  String planUnavailableError(Object plan) {
    return 'L\'offre $plan n\'est actuellement pas disponible sur la boutique. Veuillez réessayer plus tard.';
  }

  @override
  String couldNotLoadSubscription(Object error) {
    return 'Impossible de charger l\'état de l\'abonnement : $error';
  }

  @override
  String purchaseFailed(Object error) {
    return 'Échec de l\'achat : $error';
  }

  @override
  String failedToUpdateMode(Object error) {
    return 'Échec de la mise à jour du mode : $error';
  }

  @override
  String couldNotLoadPhoneNumbers(Object error) {
    return 'Impossible de charger les numéros de téléphone : $error';
  }

  @override
  String failedToUpdateNumberConfig(Object error) {
    return 'Échec de la mise à jour de la configuration du numéro : $error';
  }

  @override
  String get logOut => 'Se déconnecter';

  @override
  String get logOutConfirmMessage =>
      'Cette action supprime votre Account SID et votre Auth Token Twilio de cet appareil. Vous pouvez vous reconnecter à tout moment.';

  @override
  String get licenseTitle => 'Licence';

  @override
  String get licenseSubtitle =>
      'Votre abonnement Dialcrest pour ce compte Twilio.';

  @override
  String get purchasingUnavailable =>
      'Les achats ne sont pas disponibles sur cette plateforme.';

  @override
  String get trialExpired => 'Essai expiré';

  @override
  String get subscriptionExpired => 'Abonnement expiré';

  @override
  String trialDaysLeft(num days) {
    String _temp0 = intl.Intl.pluralLogic(
      days,
      locale: localeName,
      other: 'jours restants',
      one: 'jour restant',
    );
    return 'Essai — $days $_temp0';
  }

  @override
  String renewsOn(Object date) {
    return 'Renouvellement le $date';
  }

  @override
  String expiresOnAutoRenewOff(Object date) {
    return 'Expire le $date — le renouvellement automatique est désactivé';
  }

  @override
  String get monthly => 'Mensuel';

  @override
  String get yearly => 'Annuel';

  @override
  String get perMonthSuffix => '/mois';

  @override
  String get perYearSuffix => '/an';

  @override
  String get yearlyDiscountNote =>
      'En choisissant l\'abonnement annuel, vous bénéficiez de 2 mois offerts. Les abonnements se renouvellent automatiquement jusqu\'à annulation.';

  @override
  String get modeTitle => 'Mode';

  @override
  String get modeSubtitleVacation =>
      'Cet appareil ne sonnera pas pour les appels entrants. Les autres personnes utilisant ce compte Twilio ne sont pas concernées.';

  @override
  String get modeSubtitleOnline =>
      'Cet appareil sonne normalement pour les appels entrants.';

  @override
  String get onlineMode => 'Mode en ligne';

  @override
  String get vacationMode => 'Mode absence';

  @override
  String get outgoingTitle => 'Sortant';

  @override
  String get outgoingSubtitle =>
      'Le numéro utilisé comme identifiant de l\'appelant lorsque vous passez un appel ou envoyez un message.';

  @override
  String get noPhoneNumbersFound =>
      'Aucun numéro de téléphone trouvé sur ce compte Twilio.';

  @override
  String get incomingTitle => 'Entrant';

  @override
  String get incomingSubtitle =>
      'Seuls les numéros cochés sonnent dans cette application.';

  @override
  String moreResults(Object count) {
    return '$count résultats · Plus de résultats';
  }

  @override
  String get audioMessage => 'Message audio';

  @override
  String get attachment => 'Pièce jointe';
}
