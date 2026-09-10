package be.peblet.twilio_phone

import android.content.Intent
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Exposes the extras a tapped [IncomingMessageFcmHandler] notification launched
 * this Activity with, over a small MethodChannel — the Android equivalent of
 * `FirebaseMessaging.getInitialMessage()`/`onMessageOpenedApp`, needed because
 * those never fire on Android here (see IncomingMessageFcmHandler's doc comment
 * for why: `VoiceFirebaseMessagingService` is the app's one FCM receiver, so
 * incoming-message pushes are handled natively rather than reaching Flutter's
 * own FCM plugin).
 */
class MainActivity : FlutterActivity() {
    private val channel = "be.peblet.twilio_phone/incoming_message"
    private var pendingIntentExtras: Map<String, String?>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingIntentExtras = extractExtras(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val extras = extractExtras(intent) ?: return
        pendingIntentExtras = extras
        MethodChannel(flutterEngine!!.dartExecutor.binaryMessenger, channel)
            .invokeMethod("onIncomingMessage", extras)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "getInitialIncomingMessage" -> {
                        // Consumed once, so a later resume doesn't reopen the same conversation.
                        result.success(pendingIntentExtras)
                        pendingIntentExtras = null
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun extractExtras(intent: Intent): Map<String, String?>? {
        val from = intent.getStringExtra(IncomingMessageFcmHandler.EXTRA_FROM) ?: return null
        return mapOf(
            "from" to from,
            "body" to intent.getStringExtra(IncomingMessageFcmHandler.EXTRA_BODY),
            "sid" to intent.getStringExtra(IncomingMessageFcmHandler.EXTRA_SID),
        )
    }
}
