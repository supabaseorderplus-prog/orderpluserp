package com.hometech.app

import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Exposed to the WebView as `window.AndroidTracking`.
 * The Capacitor shim injected by MainActivity wraps these methods to satisfy
 * window.Capacitor.Plugins.BackgroundLocation that the salesman page expects.
 */
class TrackingJsBridge(private val context: Context) {

    companion object {
        const val AUTH_PREFS_NAME = "hometech_auth"
        const val KEY_AUTH_SESSION = "session_json"
    }

    private val TAG = "TrackingBridge"

    /**
     * Called by the web page when the salesman starts duty.
     * optsJson = { authToken, refreshToken, companyId, userId }
     */
    @JavascriptInterface
    fun startTracking(optsJson: String): String {
        return try {
            val opts      = JSONObject(optsJson)
            val authToken = opts.optString("authToken", "")
            val refreshToken = opts.optString("refreshToken", "")
            val companyId = opts.optString("companyId", "")
            val resumeActiveDuty = opts.optBoolean("resumeActiveDuty", false)

            if (authToken.isEmpty()) {
                return trackingResult(false, "A valid login is required before duty tracking can start.")
            }
            if (!hasFineLocationPermission()) {
                return trackingResult(false, "Allow precise location before starting duty.")
            }
            if (!hasBackgroundLocationPermission()) {
                // Android 11+ removed "Allow all the time" from the runtime
                // dialog. A deliberate Start Duty tap takes the user to the app
                // permission page where that setting is available.
                if (!resumeActiveDuty) openAppLocationPermissionSettings()
                return trackingResult(
                    false,
                    "Set Location permission to Allow all the time, then return and start duty again.",
                    requiresBackgroundPermission = true
                )
            }

            // Persist the duty decision synchronously before launching the
            // service. A fast Recents swipe must not race an asynchronous write.
            context.getSharedPreferences(
                LocationTrackingService.PREFS_NAME, Context.MODE_PRIVATE
            ).edit().putBoolean(LocationTrackingService.KEY_DUTY_ACTIVE, true).commit()

            val intent = Intent(context, LocationTrackingService::class.java).apply {
                action = LocationTrackingService.ACTION_START
                putExtra("authToken", authToken)
                putExtra("refreshToken", refreshToken)
                putExtra("companyId", companyId)
                putExtra("baseUrl",   MainActivity.APP_URL)
            }
            ContextCompat.startForegroundService(context, intent)
            Log.i(TAG, "startTracking: foreground service started")
            trackingResult(true)
        } catch (e: Exception) {
            Log.e(TAG, "startTracking error: ${e.message}")
            trackingResult(false, "Android could not start duty tracking: ${e.message ?: "unknown error"}")
        }
    }

    /** Called when salesman ends duty. */
    @JavascriptInterface
    fun stopTracking() {
        try {
            // Send an explicit command instead of calling stopService(). The
            // service itself commits the inactive bit before teardown, ensuring
            // neither the boot receiver nor watchdog can resurrect ended duty.
            val intent = Intent(context, LocationTrackingService::class.java).apply {
                action = LocationTrackingService.ACTION_STOP
            }
            context.startService(intent)
            Log.i(TAG, "stopTracking: explicit End Duty command sent")
        } catch (e: Exception) {
            Log.e(TAG, "stopTracking error: ${e.message}")
        }
    }

    /** Returns true if the tracking service is currently running. */
    @JavascriptInterface
    fun isTracking(): Boolean {
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            ?: return false
        @Suppress("DEPRECATION")
        return manager.getRunningServices(Int.MAX_VALUE).any {
            it.service.packageName == context.packageName &&
                it.service.className == LocationTrackingService::class.java.name &&
                it.foreground
        }
    }

    /** Fresh tokens rotated by the background service, for WebView session sync. */
    @JavascriptInterface
    fun getAuthTokens(): String {
        val prefs = context.getSharedPreferences(
            LocationTrackingService.PREFS_NAME, Context.MODE_PRIVATE
        )
        val access = prefs.getString(LocationTrackingService.KEY_TOKEN, "") ?: ""
        val refresh = prefs.getString(LocationTrackingService.KEY_REFRESH_TOKEN, "") ?: ""
        if (access.isNotEmpty()) return JSONObject().apply {
            put("accessToken", access)
            put("refreshToken", refresh)
        }.toString()
        return try { getAuthSession() } catch (_: Exception) { "{}" }
    }

    /** Durable app login, independent from whether GPS duty tracking is active. */
    @JavascriptInterface
    fun saveAuthSession(sessionJson: String) {
        try {
            val session = JSONObject(sessionJson)
            if (session.optString("accessToken").isEmpty() ||
                session.optString("refreshToken").isEmpty() || !session.has("user")) return
            context.getSharedPreferences(AUTH_PREFS_NAME, Context.MODE_PRIVATE).edit()
                .putString(KEY_AUTH_SESSION, session.toString()).apply()
        } catch (e: Exception) {
            Log.w(TAG, "Unable to persist auth session: ${e.message}")
        }
    }

    @JavascriptInterface
    fun getAuthSession(): String = context.getSharedPreferences(
        AUTH_PREFS_NAME, Context.MODE_PRIVATE
    ).getString(KEY_AUTH_SESSION, "{}") ?: "{}"

    @JavascriptInterface
    fun clearAuthSession() {
        context.getSharedPreferences(AUTH_PREFS_NAME, Context.MODE_PRIVATE).edit()
            .remove(KEY_AUTH_SESSION).apply()
    }

    /**
     * Returns full GPS and permission status object expected by salesman dashboard.
     */
    @JavascriptInterface
    fun getGpsStatus(): String {
        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as? android.location.LocationManager
        val locationServicesEnabled = locationManager?.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER) == true ||
                locationManager?.isProviderEnabled(android.location.LocationManager.NETWORK_PROVIDER) == true

        val fineGranted = hasFineLocationPermission()
        val backgroundGranted = hasBackgroundLocationPermission()

        val notificationsGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(
                context, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED

        val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val batteryExempt = Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            powerManager?.isIgnoringBatteryOptimizations(context.packageName) == true

        return JSONObject().apply {
            put("locationServicesEnabled", locationServicesEnabled)
            put("fineLocationGranted", fineGranted)
            put("backgroundLocationGranted", backgroundGranted)
            put("notificationsGranted", notificationsGranted)
            put("batteryOptimizationDisabled", batteryExempt)
            put("trackingActive", isTracking())
        }.toString()
    }

    /** Directly opens Android Location/GPS settings screen. */
    @JavascriptInterface
    fun openLocationSettings(): Boolean {
        return try {
            val intent = Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            true
        } catch (e: Exception) {
            try {
                val intent = Intent(android.provider.Settings.ACTION_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                true
            } catch (_: Exception) { false }
        }
    }

    /** Directly opens Android App Notification settings screen. */
    @JavascriptInterface
    fun openNotificationSettings(): Boolean {
        return try {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                    putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            } else {
                Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = android.net.Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            }
            context.startActivity(intent)
            true
        } catch (_: Exception) { false }
    }

    /** Directly opens Android Battery Optimization / Background execution settings screen. */
    @JavascriptInterface
    fun openBackgroundSettings(): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = android.net.Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            } else {
                val intent = Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = android.net.Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            }
            true
        } catch (e: Exception) {
            try {
                val intent = Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                true
            } catch (_: Exception) { false }
        }
    }

    /** Directly opens Location settings when GPS is off. */
    @JavascriptInterface
    fun showGpsOffWarning() {
        openLocationSettings()
    }

    /** Opens the app permission page that contains "Allow all the time". */
    @JavascriptInterface
    fun requestBackgroundPermission(): Boolean {
        if (hasBackgroundLocationPermission()) return true
        Log.d(TAG, "requestBackgroundPermission called — opening app location permissions")
        openAppLocationPermissionSettings()
        return false
    }

    /** Current native reliability state shown to the web workflow. */
    @JavascriptInterface
    fun getReliabilityStatus(): String {
        val fineGranted = hasFineLocationPermission()
        val backgroundGranted = hasBackgroundLocationPermission()
        val notificationsGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(
                context, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val batteryExempt = Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            powerManager?.isIgnoringBatteryOptimizations(context.packageName) == true

        return JSONObject().apply {
            put("fineLocationGranted", fineGranted)
            put("backgroundLocationGranted", backgroundGranted)
            put("notificationsGranted", notificationsGranted)
            put("batteryOptimizationDisabled", batteryExempt)
        }.toString()
    }

    private fun hasFineLocationPermission(): Boolean = ContextCompat.checkSelfPermission(
        context, Manifest.permission.ACCESS_FINE_LOCATION
    ) == PackageManager.PERMISSION_GRANTED

    private fun hasBackgroundLocationPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_BACKGROUND_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

    private fun openAppLocationPermissionSettings(): Boolean {
        return try {
            Toast.makeText(
                context,
                "Open Permissions → Location → Allow all the time",
                Toast.LENGTH_LONG
            ).show()
            context.startActivity(
                Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = android.net.Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            )
            true
        } catch (e: Exception) {
            Log.w(TAG, "Could not open app location permission settings: ${e.message}")
            false
        }
    }

    private fun trackingResult(
        started: Boolean,
        error: String? = null,
        requiresBackgroundPermission: Boolean = false
    ): String = JSONObject().apply {
        put("started", started)
        put("requiresBackgroundPermission", requiresBackgroundPermission)
        if (error != null) put("error", error)
    }.toString()
}
