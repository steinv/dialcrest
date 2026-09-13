import 'dart:convert';

import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'firebase_options.dart';
import 'l10n/generated/app_localizations.dart';
import 'screens/home_screen.dart';
import 'screens/auth_screen.dart';
import 'services/storage_service.dart';
import 'services/twilio_service.dart';
import 'services/contacts_service.dart';

/// Handles an incoming-message push while the app is backgrounded or fully
/// killed. Must be a top-level (or static) function, registered before
/// runApp — Firebase relaunches it in a fresh background isolate, so it
/// re-initializes flutter_local_notifications itself rather than relying on
/// any app state.
///
/// This only actually fires on iOS: on Android, incoming-message pushes are
/// claimed and handled natively by IncomingMessageFcmHandler.kt before they'd
/// ever reach Dart (see TwilioService.onIncomingMessage's doc comment for
/// why). The backend sends a silent/data-only push (no top-level
/// `notification` field), so — unlike a normal remote notification — iOS
/// won't auto-display anything here on its own; this builds the notification
/// from `message.data` explicitly.
@pragma('vm:entry-point')
Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  if (message.data['dialcrest_type'] != 'incoming_message') return;

  // Fresh isolate, no TwilioService instance around to ask — read this
  // device's vacation-mode flag for the message's tenant directly. Mirrors
  // the per-device/per-account suppression TwilioService.isVacationMode does
  // elsewhere; other devices on the same Twilio account are unaffected since
  // this only ever reads local storage.
  final accountSid = message.data['accountSid'];
  if (accountSid != null) {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool('vacation_mode_$accountSid') ?? false) return;
  }

  final from = message.data['from'] ?? '';
  final body = message.data['body'] ?? '';

  final localNotifications = FlutterLocalNotificationsPlugin();
  await localNotifications.initialize(
    const InitializationSettings(iOS: DarwinInitializationSettings()),
  );
  await localNotifications.show(
    (message.data['messageSid'] ?? from).hashCode,
    from,
    body,
    const NotificationDetails(
      iOS: DarwinNotificationDetails(presentAlert: true, presentBadge: true, presentSound: true),
    ),
    payload: jsonEncode({'from': from, 'body': body}),
  );
}

void main() async {
  // dfInitMessageListener(); TODO what is this, do i need it
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);
  // Play Integrity / App Attest only recognize builds Google/Apple know
  // about (e.g. a Play Console release), so release builds handed to
  // testers via Firebase App Distribution need the debug provider instead
  // — pass --dart-define=appCheckDebugProvider=true when building those.
  final useDebugAppCheckProvider = kDebugMode || const bool.fromEnvironment('appCheckDebugProvider');
  await FirebaseAppCheck.instance.activate(
    androidProvider: useDebugAppCheckProvider
        ? AndroidProvider.debug
        : AndroidProvider.playIntegrity,
    appleProvider: useDebugAppCheckProvider
        ? AppleProvider.debug
        : AppleProvider.appAttestWithDeviceCheckFallback,
  );
  final storageService = StorageService();
  await storageService.init();

  // Re-validate stored credentials on startup so a user whose Account SID /
  // Auth Token was revoked or rotated is sent back to the auth screen instead
  // of hitting a 401 at dial time. Only clear on a definitive rejection — a
  // network failure leaves the credentials in place so we don't lock out a
  // valid user who happens to be offline.
  if (storageService.hasCredentials()) {
    try {
      final isValid = await TwilioService.validateCredentials(
        storageService.accountSid!,
        storageService.authToken!,
      );
      if (!isValid) {
        await storageService.clearCredentials();
      }
    } catch (e) {
      debugPrint('Skipping startup credential validation: $e');
    }
  }

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => storageService),
        ChangeNotifierProvider(create: (_) => ContactsService()),
      ],
      child: TwilioSoftphoneApp(),
    ),
  );
}

class TwilioSoftphoneApp extends StatelessWidget {
  const TwilioSoftphoneApp({super.key});

  @override
  Widget build(BuildContext context) {
    final storageService = Provider.of<StorageService>(context);

    const seedColor = Color(0xFF508650);

    return MaterialApp(
      title: 'Dialcrest',
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: AppLocalizations.supportedLocales,
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.light,
        colorSchemeSeed: seedColor,
      ),
      darkTheme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        colorSchemeSeed: seedColor,
      ),
      routes: {
        '/dial': (context) => HomeScreen(),
        '/auth': (context) => AuthScreen(),
      },
      initialRoute: storageService.hasCredentials() ? '/dial' : '/auth',
      debugShowCheckedModeBanner: false,
    );
  }
}
