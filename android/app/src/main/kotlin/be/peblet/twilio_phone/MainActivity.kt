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
 *
 * The same channel also carries the Android equivalent of
 * `FirebaseMessaging.onMessage`: while this Activity is resumed it publishes the
 * channel as [foregroundChannel], so [IncomingMessageFcmHandler] can hand an
 * incoming text straight to Dart (live list/thread update, in-app banner)
 * instead of posting a system notification.
 */
class MainActivity : FlutterActivity() {
    companion object {
        const val CHANNEL = "be.peblet.twilio_phone/incoming_message"

        /**
         * The incoming-message channel of the Activity currently resumed, or null
         * while the app is backgrounded. Only read and written on the main thread.
         */
        var foregroundChannel: MethodChannel? = null
            private set
    }

    private var pendingIntentExtras: Map<String, String?>? = null
    private var incomingMessageChannel: MethodChannel? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingIntentExtras = extractExtras(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val extras = extractExtras(intent) ?: return
        pendingIntentExtras = extras
        incomingMessageChannel?.invokeMethod("onIncomingMessage", extras)
    }

    override fun onResume() {
        super.onResume()
        foregroundChannel = incomingMessageChannel
    }

    override fun onPause() {
        if (foregroundChannel === incomingMessageChannel) foregroundChannel = null
        super.onPause()
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        incomingMessageChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
            .also { channel ->
                channel.setMethodCallHandler { call, result ->
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
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        if (foregroundChannel === incomingMessageChannel) foregroundChannel = null
        incomingMessageChannel = null
        super.cleanUpFlutterEngine(flutterEngine)
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
