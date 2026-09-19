import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../services/storage_service.dart';
import '../../services/twilio_service.dart';
import '../l10n/generated/app_localizations.dart';
import './home_screen.dart';

class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key});

  @override
  _AuthScreenState createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  final _formKey = GlobalKey<FormState>();
  final _accountSidController = TextEditingController();
  final _authTokenController = TextEditingController();
  final _phoneNumberController = TextEditingController();
  bool _isLoading = false;
  bool _obscureAuthToken = true;
  String? _errorMessage;

  @override
  void dispose() {
    _accountSidController.dispose();
    _authTokenController.dispose();
    _phoneNumberController.dispose();
    super.dispose();
  }

  Future<void> _authenticate() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final accountSid = _accountSidController.text.trim();
      final authToken = _authTokenController.text.trim();
      final storageService = Provider.of<StorageService>(context, listen: false);

      // Verify the credentials with Twilio before saving them, so the user
      // learns they're wrong here instead of when they first try to dial.
      final isValid = await TwilioService.validateCredentials(accountSid, authToken);
      if (!isValid) {
        if (!mounted) return;
        setState(() {
          _errorMessage = AppLocalizations.of(context)!.invalidCredentialsError;
        });
        return;
      }

      await storageService.saveCredentials(accountSid, authToken);

      if (!mounted) return;
      // Navigate to home screen
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => HomeScreen()),
      );
    } on TestCredentialsException {
      if (!mounted) return;
      setState(() {
        _errorMessage = AppLocalizations.of(context)!.testCredentialsError;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _errorMessage = AppLocalizations.of(context)!.credentialsCheckError(e.toString());
      });
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Header section
                SizedBox(height: 20),
                Image.asset(
                  'assets/images/dialcrest_logo.png',
                  height: 140,
                ),
                SizedBox(height: 20),
                Text(
                  'Dialcrest',
                  style: Theme.of(context).textTheme.titleLarge,
                  textAlign: TextAlign.center,
                ),
                SizedBox(height: 8),
                Text(
                  l10n.authSubtitle,
                  style: Theme.of(context).textTheme.bodyMedium,
                  textAlign: TextAlign.center,
                ),
                SizedBox(height: 40),

                // Form fields
                TextFormField(
                  controller: _accountSidController,
                  decoration: InputDecoration(
                    labelText: l10n.accountSidLabel,
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.account_circle),
                  ),
                  validator: (value) {
                    if (value == null || value.isEmpty) {
                      return l10n.accountSidValidatorError;
                    }
                    return null;
                  },
                ),
                SizedBox(height: 16),
                TextFormField(
                  controller: _authTokenController,
                  decoration: InputDecoration(
                    labelText: l10n.authTokenLabel,
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.vpn_key),
                    suffixIcon: IconButton(
                      icon: Icon(
                        _obscureAuthToken ? Icons.visibility : Icons.visibility_off,
                      ),
                      onPressed: () {
                        setState(() {
                          _obscureAuthToken = !_obscureAuthToken;
                        });
                      },
                    ),
                  ),
                  obscureText: _obscureAuthToken,
                  validator: (value) {
                    if (value == null || value.isEmpty) {
                      return l10n.authTokenValidatorError;
                    }
                    return null;
                  },
                ),
                SizedBox(height: 24),

                // Error message
                if (_errorMessage != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16.0),
                    child: Text(
                      _errorMessage!,
                      style: TextStyle(color: Colors.red),
                      textAlign: TextAlign.center,
                    ),
                  ),

                // Connect button
                ElevatedButton(
                  onPressed: _isLoading ? null : _authenticate,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Theme.of(context).colorScheme.secondary,
                    padding: EdgeInsets.symmetric(vertical: 16),
                  ),
                  child: _isLoading
                      ? CircularProgressIndicator(color: Colors.white)
                      : Text(
                    l10n.connect,
                    style: TextStyle(fontSize: 16, color: Colors.white),
                  ),
                ),
                SizedBox(height: 24),

                // Help text
                InkWell(
                  onTap: () => launchUrl(
                    Uri.parse('https://console.twilio.com/'),
                    mode: LaunchMode.externalApplication,
                  ),
                  child: Text(
                    l10n.consoleHelpText,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: Theme.of(context).colorScheme.secondary,
                      decoration: TextDecoration.underline,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}