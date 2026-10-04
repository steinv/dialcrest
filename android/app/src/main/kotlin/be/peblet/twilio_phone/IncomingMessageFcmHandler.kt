package be.peblet.twilio_phone

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.flutter.plugin.common.MethodChannel

/**
 * Shows a system notification for an incoming-SMS FCM push. Called from
 * [DialcrestFirebaseMessagingService.onMessageReceived] so it only ever sees
 * payloads Twilio Voice's own `TwilioVoiceFcm.handleMessage` didn't claim.
 *
 * While the app is in the foreground ([MainActivity.foregroundChannel] is set)
 * the message is handed to Dart instead, as `onForegroundMessage` — the Android
 * equivalent of `FirebaseMessaging.onMessage` — so an open conversation list or
 * thread updates live, exactly like on iOS. Dart answers true once it has taken
 * the message; anything else (no handler yet, e.g. still on the login screen, or
 * the app paused before the call landed) falls back to the system notification,
 * so a text is never silently dropped.
 *
 * Nothing is shown at all when this device is in vacation mode for the
 * message's tenant (accountSid), checked directly against the SharedPreferences
 * file Flutter's shared_preferences plugin writes to — this runs natively, often
 * with no Flutter engine around to ask. Purely a per-device/per-install check: it never
 * touches Twilio account config, so other devices on the same account keep
 * getting notified as normal, and the message itself is still delivered/
 * stored server-side regardless.
 */
object IncomingMessageFcmHandler {
    private const val CHANNEL_ID = "dialcrest_messages"
    private const val DATA_TYPE_KEY = "dialcrest_type"
    private const val DATA_TYPE_INCOMING_MESSAGE = "incoming_message"
    private const val PREFS_NAME = "FlutterSharedPreferences"

    const val EXTRA_FROM = "dialcrest_message_from"
    const val EXTRA_BODY = "dialcrest_message_body"
    const val EXTRA_SID = "dialcrest_message_sid"

    fun handle(context: Context, data: Map<String, String>) {
        if (data[DATA_TYPE_KEY] != DATA_TYPE_INCOMING_MESSAGE) return
        val from = data["from"] ?: return
        val body = data["body"] ?: ""
        val messageSid = data["messageSid"] ?: ""
        val to = data["to"] ?: ""
        val accountSid = data["accountSid"]

        val appContext = context.applicationContext

        if (accountSid != null && isVacationMode(appContext, accountSid)) return

        // onMessageReceived runs on a background thread; the channel (and the
        // foreground state it stands for) lives on the main thread.
        Handler(Looper.getMainLooper()).post {
            val channel = MainActivity.foregroundChannel
            if (channel == null) {
                showNotification(appContext, from, body, messageSid)
                return@post
            }
            val arguments = mapOf("from" to from, "body" to body, "messageSid" to messageSid, "to" to to)
            channel.invokeMethod("onForegroundMessage", arguments, object : MethodChannel.Result {
                override fun success(result: Any?) {
                    if (result != true) showNotification(appContext, from, body, messageSid)
                }

                override fun error(errorCode: String, errorMessage: String?, errorDetails: Any?) {
                    showNotification(appContext, from, body, messageSid)
                }

                override fun notImplemented() {
                    showNotification(appContext, from, body, messageSid)
                }
            })
        }
    }

    private fun showNotification(appContext: Context, from: String, body: String, messageSid: String) {
        ensureChannel(appContext)

        val launchIntent = appContext.packageManager
            .getLaunchIntentForPackage(appContext.packageName)
            ?.apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(EXTRA_FROM, from)
                putExtra(EXTRA_BODY, body)
                putExtra(EXTRA_SID, messageSid)
            } ?: return
        val pendingIntent = PendingIntent.getActivity(
            appContext,
            messageSid.hashCode(),
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // TODO: swap in a dedicated small monochrome status-bar icon; the full-
        // color launcher icon is a stopgap so notifications work today.
        val notification = NotificationCompat.Builder(appContext, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            // Title only: the intent extras keep the raw `whatsapp:` address, which
            // the app reads the conversation's channel from.
            .setContentTitle(from.removePrefix("whatsapp:"))
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        // Missing POST_NOTIFICATIONS (Android 13+, denied by the user) makes
        // NotificationManagerCompat.notify a silent no-op rather than a crash,
        // so no permission check is needed here.
        NotificationManagerCompat.from(appContext).notify(messageSid.hashCode(), notification)
    }

    /**
     * Mirrors TwilioService.isVacationMode (Dart) / StorageService.getVacationMode
     * — same key, same "FlutterSharedPreferences" file the shared_preferences
     * plugin's legacy API writes to on Android, with its "flutter." key prefix.
     */
    private fun isVacationMode(context: Context, accountSid: String): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean("flutter.vacation_mode_$accountSid", false)
    }

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH),
        )
    }
}
