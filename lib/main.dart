import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';
import 'firebase_options.dart';
import 'l10n/generated/app_localizations.dart';
import 'screens/home_screen.dart';
import 'screens/auth_screen.dart';
import 'services/storage_service.dart';
import 'services/twilio_service.dart';
import 'services/contacts_service.dart';

void main() async {
  // dfInitMessageListener(); TODO what is this, do i need it
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  await FirebaseAppCheck.instance.activate(
    androidProvider: kDebugMode
        ? AndroidProvider.debug
        : AndroidProvider.playIntegrity,
    appleProvider: kDebugMode
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
