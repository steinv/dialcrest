// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get authSubtitle =>
      'Enter your Twilio credentials to start making and receiving calls and messages.';

  @override
  String get accountSidLabel => 'Account SID';

  @override
  String get accountSidValidatorError => 'Please enter your Account SID';

  @override
  String get authTokenLabel => 'Auth Token';

  @override
  String get authTokenValidatorError => 'Please enter your Auth Token';

  @override
  String get connect => 'Connect';

  @override
  String get consoleHelpText =>
      'You can find your Account SID and Auth Token in your Twilio Console.';

  @override
  String get invalidCredentialsError =>
      'Invalid Account SID or Auth Token or suspended account. Check your Twilio Console and try again.';

  @override
  String credentialsCheckError(Object error) {
    return 'Could not verify credentials (check your connection): $error';
  }

  @override
  String get noCallHistory => 'No call history';

  @override
  String get couldNotLoadCallHistory => 'Could not load call history';

  @override
  String get retry => 'Retry';

  @override
  String failedToLoadCallHistory(Object error) {
    return 'Failed to load call history: $error';
  }

  @override
  String get callTypeMissed => 'Missed';

  @override
  String get callTypeIncoming => 'Incoming';

  @override
  String get callTypeOutgoing => 'Outgoing';

  @override
  String get addToContacts => 'Add to Contacts';

  @override
  String get message => 'Message';

  @override
  String get call => 'Call';

  @override
  String get deleteFromHistory => 'Delete from history';

  @override
  String get deleteCallConfirm =>
      'Permanently delete this call from Twilio? This can\'t be undone.';

  @override
  String get callDeleted => 'Call deleted';

  @override
  String failedToDeleteCall(Object error) {
    return 'Failed to delete call: $error';
  }

  @override
  String durationHoursMinutes(Object hours, Object minutes) {
    return '${hours}h ${minutes}m';
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
    return 'Could not start call to $number';
  }

  @override
  String connectingTo(Object number) {
    return 'Connecting to $number…';
  }

  @override
  String failedToMakeCall(Object error) {
    return 'Failed to make call: $error';
  }

  @override
  String get contactsPermissionDenied =>
      'Contacts permission was denied. Contact names won\'t be shown until it\'s granted in system Settings > Apps.';

  @override
  String failedToSwitchNumber(Object error) {
    return 'Failed to switch number: $error';
  }

  @override
  String get incomingCallTitle => 'Incoming Call';

  @override
  String incomingCallBody(Object name) {
    return 'From: $name';
  }

  @override
  String get newMessageTitle => 'New Message';

  @override
  String get newConversationTitle => 'New Conversation';

  @override
  String get phoneNumberOrContactHint => 'Phone number or contact name';

  @override
  String get cancel => 'Cancel';

  @override
  String get start => 'Start';

  @override
  String get newConversationTooltip => 'New conversation';

  @override
  String get contactsTitle => 'Contacts';

  @override
  String get searchContactsHint => 'Search contacts';

  @override
  String get noContactsFound => 'No contacts found';

  @override
  String get dialerTabLabel => 'Dialer';

  @override
  String get callsTabLabel => 'Calls';

  @override
  String get messagesTabLabel => 'Messages';

  @override
  String get settingsTabLabel => 'Settings';

  @override
  String get appBarTitleCallHistory => 'Call History';

  @override
  String get appBarTitleDefault => 'Twilio Softphone';

  @override
  String get switchOutgoingNumberTooltip => 'Switch outgoing number';

  @override
  String switchOutgoingNumberTooltipWithCurrent(Object number) {
    return 'Switch outgoing number (current: $number)';
  }

  @override
  String get somethingWentWrong => 'Something went wrong';

  @override
  String failedToLoadMessages(Object error) {
    return 'Failed to load messages: $error';
  }

  @override
  String failedToLoadMoreMessages(Object error) {
    return 'Failed to load more messages: $error';
  }

  @override
  String failedToSendMessage(Object error) {
    return 'Failed to send message: $error';
  }

  @override
  String get delete => 'Delete';

  @override
  String get share => 'Share';

  @override
  String get copy => 'Copy';

  @override
  String get copiedToClipboard => 'Copied to clipboard';

  @override
  String get deleteMessage => 'Delete message';

  @override
  String get deleteConversation => 'Delete conversation';

  @override
  String get openConversation => 'Open conversation';

  @override
  String get deleteMessageConfirm =>
      'Permanently delete this message from Twilio? This can\'t be undone.';

  @override
  String deleteConversationConfirm(Object count) {
    return 'Permanently delete this whole conversation ($count messages) from Twilio? This can\'t be undone.';
  }

  @override
  String get messageDeleted => 'Message deleted';

  @override
  String get conversationDeleted => 'Conversation deleted';

  @override
  String failedToDeleteMessage(Object error) {
    return 'Failed to delete message: $error';
  }

  @override
  String get noMessagesYet => 'No messages yet';

  @override
  String get couldNotLoadMessages => 'Could not load messages';

  @override
  String get startAConversation => 'Start a conversation';

  @override
  String get typeMessageHint => 'Type a message...';

  @override
  String planUnavailableError(Object plan) {
    return 'The $plan plan isn\'t available from the store right now. Please try again shortly.';
  }

  @override
  String couldNotLoadSubscription(Object error) {
    return 'Could not load subscription status: $error';
  }

  @override
  String purchaseFailed(Object error) {
    return 'Purchase failed: $error';
  }

  @override
  String get purchaseCanceled => 'Purchase canceled';

  @override
  String get restorePurchases => 'Restore purchases';

  @override
  String get purchasesRestored => 'Subscription restored';

  @override
  String get noPurchasesToRestore => 'No active subscription found to restore';

  @override
  String failedToUpdateMode(Object error) {
    return 'Failed to update mode: $error';
  }

  @override
  String couldNotLoadPhoneNumbers(Object error) {
    return 'Could not load phone numbers: $error';
  }

  @override
  String failedToUpdateNumberConfig(Object error) {
    return 'Failed to update number configuration: $error';
  }

  @override
  String get twilioAccountError =>
      'Check your Twilio account for issues (suspended, trial restrictions, invalid credentials).';

  @override
  String get noInternetConnection =>
      'No internet connection. Check your Wi-Fi or mobile data and try again.';

  @override
  String get logOut => 'Log out';

  @override
  String get logOutConfirmMessage =>
      'This removes your Twilio Account SID and Auth Token from this device. You can reconnect at any time.';

  @override
  String get licenseTitle => 'License';

  @override
  String get licensePlanMonthly => 'Dialcrest license — Monthly subscription';

  @override
  String get licensePlanYearly => 'Dialcrest license — Yearly subscription';

  @override
  String get purchasingUnavailable =>
      'Purchasing isn\'t available on this platform.';

  @override
  String get trialExpired => 'Trial expired';

  @override
  String get subscriptionExpired => 'Subscription expired';

  @override
  String trialDaysLeft(num days) {
    String _temp0 = intl.Intl.pluralLogic(
      days,
      locale: localeName,
      other: 'days',
      one: 'day',
    );
    return 'Trial — $days $_temp0 left';
  }

  @override
  String renewsOn(Object date) {
    return 'Renews on $date';
  }

  @override
  String expiresOnAutoRenewOff(Object date) {
    return 'Expires on $date — auto-renew is off';
  }

  @override
  String get monthly => 'Monthly';

  @override
  String get yearly => 'Yearly';

  @override
  String get perMonthSuffix => '/month';

  @override
  String get perYearSuffix => '/year';

  @override
  String get modeTitle => 'Mode';

  @override
  String get modeSubtitleVacation =>
      'This device will not ring for incoming calls or notify you of new texts.';

  @override
  String get modeSubtitleOnline =>
      'This device rings for incoming calls and notifies you of new texts, as normal.';

  @override
  String get onlineMode => 'Online mode';

  @override
  String get vacationMode => 'Vacation mode';

  @override
  String get phoneNumberTitle => 'Phone number';

  @override
  String get selectNumber => 'Select a number';

  @override
  String get advancedTitle => 'Advanced';

  @override
  String get outgoingTitle => 'Outgoing';

  @override
  String get outgoingSubtitle =>
      'The number used as caller ID when you place a call or send a text.';

  @override
  String get noPhoneNumbersFound =>
      'No phone numbers found on this Twilio account.';

  @override
  String get incomingTitle => 'Incoming';

  @override
  String get incomingSubtitle => 'Only checked numbers ring this app.';

  @override
  String moreResults(Object count) {
    return '$count results · More results';
  }

  @override
  String get audioMessage => 'Audio message';

  @override
  String get attachment => 'Attachment';

  @override
  String get onboardingSkip => 'Skip';

  @override
  String get onboardingNext => 'Next';

  @override
  String get onboardingBack => 'Back';

  @override
  String get onboardingFinish => 'Finish';

  @override
  String onboardingStepLabel(Object current, Object total) {
    return 'Step $current of $total';
  }

  @override
  String get onboardingWelcomeTitle => 'Welcome to Dialcrest';

  @override
  String get onboardingWelcomeBody =>
      'Let\'s get you set up to make and receive calls. It only takes a minute, or skip it and set things up later in Settings.';

  @override
  String get onboardingPermissionsTitle => 'Permissions';

  @override
  String get onboardingPermissionsSubtitle =>
      'Dialcrest needs a few permissions to place calls and let you know about incoming ones.';

  @override
  String get onboardingGrant => 'Grant';

  @override
  String get onboardingGranted => 'Granted';

  @override
  String get onboardingOpenSettings => 'Open settings';

  @override
  String get onboardingMicTitle => 'Microphone';

  @override
  String get onboardingMicWhy =>
      'Needed so the other person can hear you during a call.';

  @override
  String get onboardingMicHow =>
      'Tap Grant, then choose Allow in the prompt that appears.';

  @override
  String get onboardingMicDenied =>
      'Denied. Open Settings › Apps › Dialcrest › Permissions and turn on Microphone.';

  @override
  String get onboardingNotificationsTitle => 'Notifications';

  @override
  String get onboardingNotificationsWhy =>
      'So you\'re alerted when someone calls or texts you.';

  @override
  String get onboardingNotificationsHow =>
      'Tap Grant, then choose Allow notifications in the prompt.';

  @override
  String get onboardingNotificationsDenied =>
      'Denied. Open Settings › Apps › Dialcrest › Notifications and turn them on.';

  @override
  String get onboardingCallingAccountTitle => 'Phone & calling account';

  @override
  String get onboardingCallingAccountWhy =>
      'Android only rings this app for incoming calls when Dialcrest is enabled as a calling account.';

  @override
  String get onboardingCallingAccountStep1 => 'Tap Open settings below.';

  @override
  String get onboardingCallingAccountStep2 =>
      'On the Calling accounts screen that opens, find Dialcrest.';

  @override
  String get onboardingCallingAccountStep3 => 'Turn the Dialcrest toggle on.';

  @override
  String get onboardingCallingAccountStep4 =>
      'Press back to return here. This step turns green once it\'s on.';

  @override
  String get onboardingCallingAccountDenied =>
      'Not enabled yet. Open Settings › Apps › Dialcrest › Calling accounts and turn Dialcrest on.';

  @override
  String get onboardingNumberTitle => 'Your phone number';

  @override
  String get onboardingNumberChooseSubtitle =>
      'Choose the Twilio number you\'ll use to make and receive calls.';

  @override
  String onboardingNumberSingleInfo(Object number) {
    return 'You\'ll make and receive calls on $number.';
  }

  @override
  String get onboardingNumberNone =>
      'No phone numbers were found on your Twilio account. Buy a Voice-capable number in the Twilio Console, then come back and retry.';

  @override
  String get onboardingBuyNumber => 'Open Twilio Console';

  @override
  String onboardingConfiguringNumber(Object number) {
    return 'Setting up $number to receive calls…';
  }

  @override
  String onboardingNumberSetupFailed(Object error) {
    return 'Could not finish setting up incoming calls: $error';
  }

  @override
  String get onboardingDoneTitle => 'You\'re all set';

  @override
  String onboardingDoneBody(Object number) {
    return 'You can now receive calls on $number.';
  }

  @override
  String get onboardingDoneBodyNoNumber =>
      'Add a phone number in Settings whenever you\'re ready to start receiving calls.';

  @override
  String get onboardingDoneTitleIncomplete => 'Almost there';

  @override
  String get onboardingDoneIncompleteIntro =>
      'You can finish now, but these still need attention before you can make and receive calls:';

  @override
  String get onboardingDoneIncompleteHint =>
      'Go Back to set them up now, or do it later in Settings.';
}
