package com.hometech.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Periodic safety net for background tracking.
 *
 * Even with START_STICKY + onTaskRemoved + a foreground service, aggressive OEM
 * battery managers (Xiaomi/Redmi, Oppo, Vivo, Realme, Samsung…) and Doze mode
 * silently kill the tracking service once the app is in the background. An
 * AlarmManager alarm survives the service death: it fires even in Doze and
 * relaunches the service whenever duty is still active (credentials persisted)
 * but the service isn't running.
 *
 * We use an inexact `setAndAllowWhileIdle` alarm so no SCHEDULE_EXACT_ALARM
 * permission is required. When the user has granted the battery-optimization
 * exemption, Doze throttling is lifted and it effectively fires every minute.
 */
class TrackingWatchdogReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG        = "HomeTechTracking"
        private const val ACTION     = "com.hometech.app.WATCHDOG_TICK"
        private const val REQ_CODE   = 7011
        private const val INTERVAL_MS = 60_000L

        private fun alarmIntent(context: Context): PendingIntent {
            val intent = Intent(context, TrackingWatchdogReceiver::class.java).setAction(ACTION)
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            else PendingIntent.FLAG_UPDATE_CURRENT
            return PendingIntent.getBroadcast(context, REQ_CODE, intent, flags)
        }

        /** Arm the next watchdog tick. Exact-while-idle alarms are one-shot, so the
         *  receiver re-arms itself after every fire. */
        fun schedule(context: Context, delayMs: Long = INTERVAL_MS) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
            val triggerAt = SystemClock.elapsedRealtime() + delayMs.coerceAtLeast(1_000L)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, alarmIntent(context)
                    )
                } else {
                    am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, alarmIntent(context))
                }
            } catch (e: Exception) {
                Log.w(TAG, "Watchdog schedule failed: ${e.message}")
            }
        }

        fun cancel(context: Context) {
            try {
                (context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager)
                    ?.cancel(alarmIntent(context))
            } catch (_: Exception) {}
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        val prefs = context.getSharedPreferences(
            LocationTrackingService.PREFS_NAME, Context.MODE_PRIVATE
        )
        val dutyActive = LocationTrackingService.hasActiveDuty(prefs)
        val token = prefs.getString(LocationTrackingService.KEY_TOKEN, "") ?: ""
        val base  = prefs.getString(LocationTrackingService.KEY_BASE_URL, "") ?: ""

        // Only the durable duty bit controls resurrection. Credentials alone may
        // belong to a stale session and must never restart ended tracking.
        if (!dutyActive || token.isEmpty() || base.isEmpty()) {
            cancel(context)
            return
        }

        if (!LocationTrackingService.isRunning) {
            Log.i(TAG, "Watchdog → service not running, relaunching")
            try {
                ContextCompat.startForegroundService(
                    context, Intent(context, LocationTrackingService::class.java)
                )
            } catch (e: Exception) {
                Log.w(TAG, "Watchdog relaunch failed: ${e.message}")
            }
        }

        // Re-arm for the next tick (these alarms only fire once).
        schedule(context)
    }
}
