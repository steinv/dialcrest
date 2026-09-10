package be.peblet.twilio_phone

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.twilio.twilio_voice.fcm.TwilioVoiceFcm

/**
 * The app's one registered FCM receiver (see AndroidManifest.xml) — Android
 * only reliably delivers a push to a single FirebaseMessagingService per app,
 * so this is the entry point for both Twilio Voice call pushes and
 * Dialcrest's own incoming-SMS pushes.
 *
 * Voice pushes are handed to [TwilioVoiceFcm.handleMessage] first; whatever
 * it doesn't claim (i.e. not a valid Twilio Voice payload) falls through to
 * [IncomingMessageFcmHandler].
 */
class DialcrestFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        TwilioVoiceFcm.updateToken(applicationContext, token)
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val handled = TwilioVoiceFcm.handleMessage(applicationContext, remoteMessage.data)
        if (!handled) {
            IncomingMessageFcmHandler.handle(applicationContext, remoteMessage.data)
        }
    }
}
