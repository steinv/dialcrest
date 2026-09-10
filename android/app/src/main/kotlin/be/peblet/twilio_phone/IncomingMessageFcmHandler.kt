package be.peblet.twilio_phone

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Shows a system notification for an incoming-SMS FCM push. Called from
 * [DialcrestFirebaseMessagingService.onMessageReceived] so it only ever sees
 * payloads Twilio Voice's own `TwilioVoiceFcm.handleMessage` didn't claim.
 *
 * Always shows the notification, whether the app is foregrounded or not —
 * simpler than branching on process state, and Android already surfaces a
 * heads-up notification fine even while the app is open.
 */
object IncomingMessageFcmHandler {
    private const val CHANNEL_ID = "dialcrest_messages"
    private const val DATA_TYPE_KEY = "dialcrest_type"
    private const val DATA_TYPE_INCOMING_MESSAGE = "incoming_message"

    const val EXTRA_FROM = "dialcrest_message_from"
    const val EXTRA_BODY = "dialcrest_message_body"
    const val EXTRA_SID = "dialcrest_message_sid"

    fun handle(context: Context, data: Map<String, String>) {
        if (data[DATA_TYPE_KEY] != DATA_TYPE_INCOMING_MESSAGE) return
        val from = data["from"] ?: return
        val body = data["body"] ?: ""
        val messageSid = data["messageSid"] ?: ""

        val appContext = context.applicationContext
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
            .setContentTitle(from)
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

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH),
        )
    }
}
