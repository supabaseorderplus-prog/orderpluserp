package com.hometech.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Restarts duty tracking after device reboot or app update,
 * but only if the salesman had an active duty (token persisted in prefs).
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED &&
            action != "android.intent.action.QUICKBOOT_POWERON") return

        val prefs = context.getSharedPreferences(
            LocationTrackingService.PREFS_NAME, Context.MODE_PRIVATE
        )
        val token = prefs.getString(LocationTrackingService.KEY_TOKEN, "") ?: ""
        val base  = prefs.getString(LocationTrackingService.KEY_BASE_URL, "") ?: ""
        if (!LocationTrackingService.hasActiveDuty(prefs) ||
            token.isEmpty() || base.isEmpty()) return

        Log.i("HomeTechTracking", "BootReceiver → resuming duty tracking")
        val svc = Intent(context, LocationTrackingService::class.java).apply {
            setAction(LocationTrackingService.ACTION_START)
        }
        try {
            ContextCompat.startForegroundService(context, svc)
        } catch (e: Exception) {
            Log.w("HomeTechTracking", "BootReceiver failed: ${e.message}")
        }
    }
}
