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
  String get testCredentialsError =>
      'Ce sont des identifiants de test Twilio, que cette application ne peut pas utiliser. Saisissez votre Account SID et Auth Token réels (un compte d\'essai fonctionne aussi).';

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
  String get addToContacts => 'Ajouter aux contacts';

  @override
  String get message => 'Message';

  @override
  String get call => 'Appeler';

  @override
  String get deleteFromHistory => 'Supprimer de l\'historique';

  @override
  String get deleteCallConfirm =>
      'Supprimer définitivement cet appel de Twilio ? Cette action est irréversible.';

  @override
  String get callDeleted => 'Appel supprimé';

  @override
  String failedToDeleteCall(Object error) {
    return 'Échec de la suppression de l\'appel : $error';
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
  String get contactsTitle => 'Contacts';

  @override
  String get searchContactsHint => 'Rechercher des contacts';

  @override
  String get noContactsFound => 'Aucun contact trouvé';

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
  String get delete => 'Supprimer';

  @override
  String get share => 'Partager';

  @override
  String get copy => 'Copier';

  @override
  String get copiedToClipboard => 'Copié dans le presse-papiers';

  @override
  String get deleteMessage => 'Supprimer le message';

  @override
  String get deleteConversation => 'Supprimer la conversation';

  @override
  String get openConversation => 'Ouvrir la conversation';

  @override
  String get deleteMessageConfirm =>
      'Supprimer définitivement ce message de Twilio ? Cette action est irréversible.';

  @override
  String deleteConversationConfirm(Object count) {
    return 'Supprimer définitivement toute cette conversation ($count messages) de Twilio ? Cette action est irréversible.';
  }

  @override
  String get messageDeleted => 'Message supprimé';

  @override
  String get conversationDeleted => 'Conversation supprimée';

  @override
  String failedToDeleteMessage(Object error) {
    return 'Échec de la suppression du message : $error';
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
  String get purchaseCanceled => 'Achat annulé';

  @override
  String get restorePurchases => 'Restaurer les achats';

  @override
  String get purchasesRestored => 'Abonnement restauré';

  @override
  String get noPurchasesToRestore => 'Aucun abonnement actif à restaurer';

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
  String get twilioAccountError =>
      'Vérifiez votre compte Twilio (suspension, restrictions d\'essai, identifiants invalides).';

  @override
  String get noInternetConnection =>
      'Pas de connexion Internet. Vérifiez votre Wi-Fi ou vos données mobiles, puis réessayez.';

  @override
  String get logOut => 'Se déconnecter';

  @override
  String get logOutConfirmMessage =>
      'Cette action supprime votre Account SID et votre Auth Token Twilio de cet appareil. Vous pouvez vous reconnecter à tout moment.';

  @override
  String get licenseTitle => 'Licence';

  @override
  String get licensePlanMonthly => 'Licence Dialcrest — Abonnement mensuel';

  @override
  String get licensePlanYearly => 'Licence Dialcrest — Abonnement annuel';

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
  String get modeTitle => 'Mode';

  @override
  String get modeSubtitleVacation =>
      'Cet appareil ne sonnera pas pour les appels entrants et ne vous avertira pas des nouveaux messages.';

  @override
  String get modeSubtitleOnline =>
      'Cet appareil sonne normalement pour les appels entrants et vous avertit des nouveaux messages.';

  @override
  String get onlineMode => 'Mode en ligne';

  @override
  String get vacationMode => 'Mode absence';

  @override
  String get timeFormatTitle => 'Format de l\'heure';

  @override
  String get timeFormat24h => '24 heures';

  @override
  String get timeFormat12h => 'AM/PM';

  @override
  String get phoneNumberTitle => 'Numéro de téléphone';

  @override
  String get selectNumber => 'Sélectionner un numéro';

  @override
  String get advancedTitle => 'Avancé';

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

  @override
  String get onboardingSkip => 'Ignorer';

  @override
  String get onboardingNext => 'Suivant';

  @override
  String get onboardingBack => 'Retour';

  @override
  String get onboardingFinish => 'Terminer';

  @override
  String onboardingStepLabel(Object current, Object total) {
    return 'Étape $current sur $total';
  }

  @override
  String get onboardingWelcomeTitle => 'Bienvenue sur Dialcrest';

  @override
  String get onboardingWelcomeBody =>
      'Configurons tout pour que vous puissiez passer et recevoir des appels. Cela ne prend qu\'une minute, ou ignorez cette étape et configurez tout plus tard dans les Réglages.';

  @override
  String get onboardingPermissionsTitle => 'Autorisations';

  @override
  String get onboardingPermissionsSubtitle =>
      'Dialcrest a besoin de quelques autorisations pour passer des appels et vous avertir des appels entrants.';

  @override
  String get onboardingGrant => 'Autoriser';

  @override
  String get onboardingGranted => 'Accordée';

  @override
  String get onboardingOpenSettings => 'Ouvrir les réglages';

  @override
  String get onboardingMicTitle => 'Microphone';

  @override
  String get onboardingMicWhy =>
      'Nécessaire pour que votre interlocuteur puisse vous entendre pendant un appel.';

  @override
  String get onboardingMicHow =>
      'Touchez Autoriser, puis choisissez Autoriser dans la fenêtre qui apparaît.';

  @override
  String get onboardingMicDenied =>
      'Refusé. Ouvrez Réglages › Applications › Dialcrest › Autorisations et activez le Microphone.';

  @override
  String get onboardingNotificationsTitle => 'Notifications';

  @override
  String get onboardingNotificationsWhy =>
      'Pour être averti lorsque quelqu\'un vous appelle ou vous envoie un message.';

  @override
  String get onboardingNotificationsHow =>
      'Touchez Autoriser, puis choisissez Autoriser les notifications dans la fenêtre.';

  @override
  String get onboardingNotificationsDenied =>
      'Refusé. Ouvrez Réglages › Applications › Dialcrest › Notifications et activez-les.';

  @override
  String get onboardingCallingAccountTitle => 'Téléphone et compte d\'appel';

  @override
  String get onboardingCallingAccountWhy =>
      'Android ne fait sonner cette application pour les appels entrants que lorsque Dialcrest est activé comme compte d\'appel.';

  @override
  String get onboardingCallingAccountStep1 =>
      'Touchez Ouvrir les réglages ci-dessous.';

  @override
  String get onboardingCallingAccountStep2 =>
      'Sur l\'écran Comptes d\'appel qui s\'ouvre, trouvez Dialcrest.';

  @override
  String get onboardingCallingAccountStep3 => 'Activez le bouton Dialcrest.';

  @override
  String get onboardingCallingAccountStep4 =>
      'Appuyez sur retour pour revenir ici. Cette étape devient verte une fois activée.';

  @override
  String get onboardingCallingAccountDenied =>
      'Pas encore activé. Ouvrez Réglages › Applications › Dialcrest › Comptes d\'appel et activez Dialcrest.';

  @override
  String get onboardingNumberTitle => 'Votre numéro de téléphone';

  @override
  String get onboardingNumberChooseSubtitle =>
      'Choisissez le numéro Twilio que vous utiliserez pour passer et recevoir des appels.';

  @override
  String onboardingNumberSingleInfo(Object number) {
    return 'Vous passerez et recevrez des appels sur $number.';
  }

  @override
  String get onboardingNumberNone =>
      'Aucun numéro de téléphone n\'a été trouvé sur votre compte Twilio. Achetez un numéro compatible voix dans la Twilio Console, puis revenez et réessayez.';

  @override
  String get onboardingBuyNumber => 'Ouvrir la Twilio Console';

  @override
  String onboardingConfiguringNumber(Object number) {
    return 'Configuration de $number pour les appels entrants…';
  }

  @override
  String onboardingNumberSetupFailed(Object error) {
    return 'Impossible de terminer la configuration des appels entrants : $error';
  }

  @override
  String get onboardingDoneTitle => 'Tout est prêt';

  @override
  String onboardingDoneBody(Object number) {
    return 'Vous pouvez maintenant recevoir des appels sur $number.';
  }

  @override
  String get onboardingDoneBodyNoNumber =>
      'Ajoutez un numéro de téléphone dans les Réglages quand vous serez prêt à recevoir des appels.';

  @override
  String get onboardingDoneTitleIncomplete => 'Presque terminé';

  @override
  String get onboardingDoneIncompleteIntro =>
      'Vous pouvez terminer maintenant, mais les éléments suivants nécessitent encore votre attention avant de pouvoir passer et recevoir des appels :';

  @override
  String get onboardingDoneIncompleteHint =>
      'Revenez en arrière pour les configurer maintenant, ou faites-le plus tard dans les Réglages.';
}
