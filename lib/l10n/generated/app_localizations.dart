import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_de.dart';
import 'app_localizations_en.dart';
import 'app_localizations_es.dart';
import 'app_localizations_fr.dart';
import 'app_localizations_nl.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'generated/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations? of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations);
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('de'),
    Locale('en'),
    Locale('es'),
    Locale('fr'),
    Locale('nl'),
  ];

  /// No description provided for @authSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Enter your Twilio credentials to start making and receiving calls and messages.'**
  String get authSubtitle;

  /// No description provided for @accountSidLabel.
  ///
  /// In en, this message translates to:
  /// **'Account SID'**
  String get accountSidLabel;

  /// No description provided for @accountSidValidatorError.
  ///
  /// In en, this message translates to:
  /// **'Please enter your Account SID'**
  String get accountSidValidatorError;

  /// No description provided for @authTokenLabel.
  ///
  /// In en, this message translates to:
  /// **'Auth Token'**
  String get authTokenLabel;

  /// No description provided for @authTokenValidatorError.
  ///
  /// In en, this message translates to:
  /// **'Please enter your Auth Token'**
  String get authTokenValidatorError;

  /// No description provided for @connect.
  ///
  /// In en, this message translates to:
  /// **'Connect'**
  String get connect;

  /// No description provided for @consoleHelpText.
  ///
  /// In en, this message translates to:
  /// **'You can find your Account SID and Auth Token in your Twilio Console.'**
  String get consoleHelpText;

  /// No description provided for @invalidCredentialsError.
  ///
  /// In en, this message translates to:
  /// **'Invalid Account SID or Auth Token or suspended account. Check your Twilio Console and try again.'**
  String get invalidCredentialsError;

  /// No description provided for @credentialsCheckError.
  ///
  /// In en, this message translates to:
  /// **'Could not verify credentials (check your connection): {error}'**
  String credentialsCheckError(Object error);

  /// No description provided for @noCallHistory.
  ///
  /// In en, this message translates to:
  /// **'No call history'**
  String get noCallHistory;

  /// No description provided for @couldNotLoadCallHistory.
  ///
  /// In en, this message translates to:
  /// **'Could not load call history'**
  String get couldNotLoadCallHistory;

  /// No description provided for @retry.
  ///
  /// In en, this message translates to:
  /// **'Retry'**
  String get retry;

  /// No description provided for @failedToLoadCallHistory.
  ///
  /// In en, this message translates to:
  /// **'Failed to load call history: {error}'**
  String failedToLoadCallHistory(Object error);

  /// No description provided for @callTypeMissed.
  ///
  /// In en, this message translates to:
  /// **'Missed'**
  String get callTypeMissed;

  /// No description provided for @callTypeIncoming.
  ///
  /// In en, this message translates to:
  /// **'Incoming'**
  String get callTypeIncoming;

  /// No description provided for @callTypeOutgoing.
  ///
  /// In en, this message translates to:
  /// **'Outgoing'**
  String get callTypeOutgoing;

  /// No description provided for @missedSuffix.
  ///
  /// In en, this message translates to:
  /// **' (Missed)'**
  String get missedSuffix;

  /// No description provided for @addToContacts.
  ///
  /// In en, this message translates to:
  /// **'Add to Contacts'**
  String get addToContacts;

  /// No description provided for @callBack.
  ///
  /// In en, this message translates to:
  /// **'Call Back'**
  String get callBack;

  /// No description provided for @callDetailsType.
  ///
  /// In en, this message translates to:
  /// **'Type: {type}'**
  String callDetailsType(Object type);

  /// No description provided for @callDetailsTime.
  ///
  /// In en, this message translates to:
  /// **'Time: {time}'**
  String callDetailsTime(Object time);

  /// No description provided for @callDetailsDuration.
  ///
  /// In en, this message translates to:
  /// **'Duration: {duration}'**
  String callDetailsDuration(Object duration);

  /// No description provided for @durationHoursMinutes.
  ///
  /// In en, this message translates to:
  /// **'{hours}h {minutes}m'**
  String durationHoursMinutes(Object hours, Object minutes);

  /// No description provided for @durationMinutesSeconds.
  ///
  /// In en, this message translates to:
  /// **'{minutes}m {seconds}s'**
  String durationMinutesSeconds(Object minutes, Object seconds);

  /// No description provided for @durationSeconds.
  ///
  /// In en, this message translates to:
  /// **'{seconds}s'**
  String durationSeconds(Object seconds);

  /// No description provided for @couldNotStartCall.
  ///
  /// In en, this message translates to:
  /// **'Could not start call to {number}'**
  String couldNotStartCall(Object number);

  /// No description provided for @connectingTo.
  ///
  /// In en, this message translates to:
  /// **'Connecting to {number}…'**
  String connectingTo(Object number);

  /// No description provided for @failedToMakeCall.
  ///
  /// In en, this message translates to:
  /// **'Failed to make call: {error}'**
  String failedToMakeCall(Object error);

  /// No description provided for @contactsPermissionDenied.
  ///
  /// In en, this message translates to:
  /// **'Contacts permission was denied. Contact names won\'t be shown until it\'s granted in system Settings > Apps.'**
  String get contactsPermissionDenied;

  /// No description provided for @failedToSwitchNumber.
  ///
  /// In en, this message translates to:
  /// **'Failed to switch number: {error}'**
  String failedToSwitchNumber(Object error);

  /// No description provided for @incomingCallTitle.
  ///
  /// In en, this message translates to:
  /// **'Incoming Call'**
  String get incomingCallTitle;

  /// No description provided for @incomingCallBody.
  ///
  /// In en, this message translates to:
  /// **'From: {name}'**
  String incomingCallBody(Object name);

  /// No description provided for @newMessageTitle.
  ///
  /// In en, this message translates to:
  /// **'New Message'**
  String get newMessageTitle;

  /// No description provided for @newConversationTitle.
  ///
  /// In en, this message translates to:
  /// **'New Conversation'**
  String get newConversationTitle;

  /// No description provided for @phoneNumberOrContactHint.
  ///
  /// In en, this message translates to:
  /// **'Phone number or contact name'**
  String get phoneNumberOrContactHint;

  /// No description provided for @cancel.
  ///
  /// In en, this message translates to:
  /// **'Cancel'**
  String get cancel;

  /// No description provided for @start.
  ///
  /// In en, this message translates to:
  /// **'Start'**
  String get start;

  /// No description provided for @newConversationTooltip.
  ///
  /// In en, this message translates to:
  /// **'New conversation'**
  String get newConversationTooltip;

  /// No description provided for @dialerTabLabel.
  ///
  /// In en, this message translates to:
  /// **'Dialer'**
  String get dialerTabLabel;

  /// No description provided for @callsTabLabel.
  ///
  /// In en, this message translates to:
  /// **'Calls'**
  String get callsTabLabel;

  /// No description provided for @messagesTabLabel.
  ///
  /// In en, this message translates to:
  /// **'Messages'**
  String get messagesTabLabel;

  /// No description provided for @settingsTabLabel.
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get settingsTabLabel;

  /// No description provided for @appBarTitleCallHistory.
  ///
  /// In en, this message translates to:
  /// **'Call History'**
  String get appBarTitleCallHistory;

  /// No description provided for @appBarTitleDefault.
  ///
  /// In en, this message translates to:
  /// **'Twilio Softphone'**
  String get appBarTitleDefault;

  /// No description provided for @switchOutgoingNumberTooltip.
  ///
  /// In en, this message translates to:
  /// **'Switch outgoing number'**
  String get switchOutgoingNumberTooltip;

  /// No description provided for @switchOutgoingNumberTooltipWithCurrent.
  ///
  /// In en, this message translates to:
  /// **'Switch outgoing number (current: {number})'**
  String switchOutgoingNumberTooltipWithCurrent(Object number);

  /// No description provided for @somethingWentWrong.
  ///
  /// In en, this message translates to:
  /// **'Something went wrong'**
  String get somethingWentWrong;

  /// No description provided for @failedToLoadMessages.
  ///
  /// In en, this message translates to:
  /// **'Failed to load messages: {error}'**
  String failedToLoadMessages(Object error);

  /// No description provided for @failedToLoadMoreMessages.
  ///
  /// In en, this message translates to:
  /// **'Failed to load more messages: {error}'**
  String failedToLoadMoreMessages(Object error);

  /// No description provided for @failedToSendMessage.
  ///
  /// In en, this message translates to:
  /// **'Failed to send message: {error}'**
  String failedToSendMessage(Object error);

  /// No description provided for @noMessagesYet.
  ///
  /// In en, this message translates to:
  /// **'No messages yet'**
  String get noMessagesYet;

  /// No description provided for @couldNotLoadMessages.
  ///
  /// In en, this message translates to:
  /// **'Could not load messages'**
  String get couldNotLoadMessages;

  /// No description provided for @startAConversation.
  ///
  /// In en, this message translates to:
  /// **'Start a conversation'**
  String get startAConversation;

  /// No description provided for @typeMessageHint.
  ///
  /// In en, this message translates to:
  /// **'Type a message...'**
  String get typeMessageHint;

  /// No description provided for @planUnavailableError.
  ///
  /// In en, this message translates to:
  /// **'The {plan} plan isn\'t available from the store right now. Please try again shortly.'**
  String planUnavailableError(Object plan);

  /// No description provided for @couldNotLoadSubscription.
  ///
  /// In en, this message translates to:
  /// **'Could not load subscription status: {error}'**
  String couldNotLoadSubscription(Object error);

  /// No description provided for @purchaseFailed.
  ///
  /// In en, this message translates to:
  /// **'Purchase failed: {error}'**
  String purchaseFailed(Object error);

  /// No description provided for @purchaseCanceled.
  ///
  /// In en, this message translates to:
  /// **'Purchase canceled'**
  String get purchaseCanceled;

  /// No description provided for @restorePurchases.
  ///
  /// In en, this message translates to:
  /// **'Restore purchases'**
  String get restorePurchases;

  /// No description provided for @purchasesRestored.
  ///
  /// In en, this message translates to:
  /// **'Subscription restored'**
  String get purchasesRestored;

  /// No description provided for @noPurchasesToRestore.
  ///
  /// In en, this message translates to:
  /// **'No active subscription found to restore'**
  String get noPurchasesToRestore;

  /// No description provided for @failedToUpdateMode.
  ///
  /// In en, this message translates to:
  /// **'Failed to update mode: {error}'**
  String failedToUpdateMode(Object error);

  /// No description provided for @couldNotLoadPhoneNumbers.
  ///
  /// In en, this message translates to:
  /// **'Could not load phone numbers: {error}'**
  String couldNotLoadPhoneNumbers(Object error);

  /// No description provided for @failedToUpdateNumberConfig.
  ///
  /// In en, this message translates to:
  /// **'Failed to update number configuration: {error}'**
  String failedToUpdateNumberConfig(Object error);

  /// No description provided for @twilioAccountError.
  ///
  /// In en, this message translates to:
  /// **'Check your Twilio account for issues (suspended, trial restrictions, invalid credentials).'**
  String get twilioAccountError;

  /// No description provided for @noInternetConnection.
  ///
  /// In en, this message translates to:
  /// **'No internet connection. Check your Wi-Fi or mobile data and try again.'**
  String get noInternetConnection;

  /// No description provided for @logOut.
  ///
  /// In en, this message translates to:
  /// **'Log out'**
  String get logOut;

  /// No description provided for @logOutConfirmMessage.
  ///
  /// In en, this message translates to:
  /// **'This removes your Twilio Account SID and Auth Token from this device. You can reconnect at any time.'**
  String get logOutConfirmMessage;

  /// No description provided for @licenseTitle.
  ///
  /// In en, this message translates to:
  /// **'License'**
  String get licenseTitle;

  /// No description provided for @licenseSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Your Dialcrest subscription for this Twilio account.'**
  String get licenseSubtitle;

  /// No description provided for @purchasingUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Purchasing isn\'t available on this platform.'**
  String get purchasingUnavailable;

  /// No description provided for @trialExpired.
  ///
  /// In en, this message translates to:
  /// **'Trial expired'**
  String get trialExpired;

  /// No description provided for @subscriptionExpired.
  ///
  /// In en, this message translates to:
  /// **'Subscription expired'**
  String get subscriptionExpired;

  /// No description provided for @trialDaysLeft.
  ///
  /// In en, this message translates to:
  /// **'Trial — {days} {days, plural, one{day} other{days}} left'**
  String trialDaysLeft(num days);

  /// No description provided for @renewsOn.
  ///
  /// In en, this message translates to:
  /// **'Renews on {date}'**
  String renewsOn(Object date);

  /// No description provided for @expiresOnAutoRenewOff.
  ///
  /// In en, this message translates to:
  /// **'Expires on {date} — auto-renew is off'**
  String expiresOnAutoRenewOff(Object date);

  /// No description provided for @monthly.
  ///
  /// In en, this message translates to:
  /// **'Monthly'**
  String get monthly;

  /// No description provided for @yearly.
  ///
  /// In en, this message translates to:
  /// **'Yearly'**
  String get yearly;

  /// No description provided for @perMonthSuffix.
  ///
  /// In en, this message translates to:
  /// **'/month'**
  String get perMonthSuffix;

  /// No description provided for @perYearSuffix.
  ///
  /// In en, this message translates to:
  /// **'/year'**
  String get perYearSuffix;

  /// No description provided for @yearlyDiscountNote.
  ///
  /// In en, this message translates to:
  /// **'Purchasing for a year gives you 2 months free. Subscriptions renew automatically until canceled.'**
  String get yearlyDiscountNote;

  /// No description provided for @modeTitle.
  ///
  /// In en, this message translates to:
  /// **'Mode'**
  String get modeTitle;

  /// No description provided for @modeSubtitleVacation.
  ///
  /// In en, this message translates to:
  /// **'This device will not ring for incoming calls or notify you of new texts. Other people using this Twilio account are unaffected.'**
  String get modeSubtitleVacation;

  /// No description provided for @modeSubtitleOnline.
  ///
  /// In en, this message translates to:
  /// **'This device rings for incoming calls as normal.'**
  String get modeSubtitleOnline;

  /// No description provided for @onlineMode.
  ///
  /// In en, this message translates to:
  /// **'Online mode'**
  String get onlineMode;

  /// No description provided for @vacationMode.
  ///
  /// In en, this message translates to:
  /// **'Vacation mode'**
  String get vacationMode;

  /// No description provided for @outgoingTitle.
  ///
  /// In en, this message translates to:
  /// **'Outgoing'**
  String get outgoingTitle;

  /// No description provided for @outgoingSubtitle.
  ///
  /// In en, this message translates to:
  /// **'The number used as caller ID when you place a call or send a text.'**
  String get outgoingSubtitle;

  /// No description provided for @noPhoneNumbersFound.
  ///
  /// In en, this message translates to:
  /// **'No phone numbers found on this Twilio account.'**
  String get noPhoneNumbersFound;

  /// No description provided for @incomingTitle.
  ///
  /// In en, this message translates to:
  /// **'Incoming'**
  String get incomingTitle;

  /// No description provided for @incomingSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Only checked numbers ring this app.'**
  String get incomingSubtitle;

  /// No description provided for @moreResults.
  ///
  /// In en, this message translates to:
  /// **'{count} results · More results'**
  String moreResults(Object count);

  /// No description provided for @audioMessage.
  ///
  /// In en, this message translates to:
  /// **'Audio message'**
  String get audioMessage;

  /// No description provided for @attachment.
  ///
  /// In en, this message translates to:
  /// **'Attachment'**
  String get attachment;
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['de', 'en', 'es', 'fr', 'nl'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'de':
      return AppLocalizationsDe();
    case 'en':
      return AppLocalizationsEn();
    case 'es':
      return AppLocalizationsEs();
    case 'fr':
      return AppLocalizationsFr();
    case 'nl':
      return AppLocalizationsNl();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
