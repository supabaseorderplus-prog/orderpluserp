package com.hometech.app

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.BatteryManager
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class LocationTrackingService : Service() {

    companion object {
        @Volatile var isRunning = false
        /** Set by TrackingJsBridge before calling stopService() so onDestroy knows
         *  it was a deliberate user-initiated stop (not an OS kill). Only in that
         *  case should we wipe the saved credentials. */
        @Volatile var manualStopRequested = false

        const val PREFS_NAME      = "hometech_tracking"
        const val KEY_TOKEN       = "auth_token"
        const val KEY_REFRESH_TOKEN = "refresh_token"
        const val KEY_COMPANY     = "company_id"
        const val KEY_BASE_URL    = "base_url"
        const val KEY_START_MS    = "start_ms"
        const val KEY_DISTANCE_KM = "distance_km"
        const val KEY_PING_QUEUE  = "ping_queue"

        private const val CHANNEL_ID = "hometech_tracking_channel"
        private const val NOTIF_ID   = 2001
        private const val TAG        = "HomeTechTracking"

        // Tight point-to-point capture — never miss a movement
        private const val INTERVAL_MS         = 3_000L
        private const val MIN_INTERVAL_MS     = 2_000L
        private const val MAX_DELAY_MS        = 3_000L
        private const val MIN_DIST_FILTER_M   = 5f
        private const val MIN_VERIFIED_MOVE_M = 12f
        private const val MAX_ACCURACY_M      = 60f
        private const val MAX_SPEED_MPS       = 55f
        private const val MAX_GAP_MS          = 90_000L
        // 12,000 five-second fixes retain more than a 16-hour route if auth or
        // connectivity is unavailable, instead of dropping history after ~42m.
        private const val MAX_QUEUE           = 12_000
        // Re-send the last fix this often while stationary so the dashboard keeps
        // showing the user as "live" instead of falsely flagging "app may be closed".
        // Kept well under the dashboard's 5-min threshold without flooding the trail.
        private const val HEARTBEAT_MS        = 10_000L

        private val isoFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }
    }

    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var locationCallback: LocationCallback
    private val netExecutor = Executors.newSingleThreadScheduledExecutor()
    private var wakeLock: PowerManager.WakeLock? = null

    private var authToken  = ""
    private var refreshToken = ""
    private var companyId  = ""
    private var baseUrl    = ""
    private var startMs    = 0L

    @Volatile private var lastLocation: Location? = null
    private var totalDistanceKm: Double   = 0.0
    private var pingCount:       Int      = 0
    @Volatile private var lastPingMs: Long = 0L

    private val pendingQueue = ConcurrentLinkedQueue<JSONObject>()

    override fun onCreate() {
        super.onCreate()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        createNotificationChannel()
        acquireWakeLock()
        loadPendingQueue()
        netExecutor.scheduleWithFixedDelay({ flushQueue() }, 30, 30, TimeUnit.SECONDS)
        netExecutor.scheduleWithFixedDelay({ heartbeatIfIdle() }, 5, 5, TimeUnit.SECONDS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)

        authToken = intent?.getStringExtra("authToken")  ?: prefs.getString(KEY_TOKEN,    "") ?: ""
        refreshToken = intent?.getStringExtra("refreshToken")
            ?: prefs.getString(KEY_REFRESH_TOKEN, "") ?: ""
        companyId = intent?.getStringExtra("companyId") ?: prefs.getString(KEY_COMPANY,  "") ?: ""
        baseUrl   = intent?.getStringExtra("baseUrl")   ?: prefs.getString(KEY_BASE_URL, "") ?: ""

        if (authToken.isEmpty() || baseUrl.isEmpty()) {
            Log.w(TAG, "Missing credentials — not starting")
            stopSelf(); return START_NOT_STICKY
        }

        // First start: capture session start time. Restart: keep saved start.
        // startTracking is also used to deliver rotated credentials. Never let
        // that reset the duty clock or distance for an already-active duty.
        startMs = prefs.getLong(KEY_START_MS, 0L).takeIf { it > 0 }
            ?: System.currentTimeMillis()
        totalDistanceKm = prefs.getFloat(KEY_DISTANCE_KM, 0f).toDouble()

        prefs.edit()
            .putString(KEY_TOKEN,    authToken)
            .putString(KEY_REFRESH_TOKEN, refreshToken)
            .putString(KEY_COMPANY,  companyId)
            .putString(KEY_BASE_URL, baseUrl)
            .putLong  (KEY_START_MS, startMs)
            .apply()

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "No location permission — stopping"); stopSelf(); return START_NOT_STICKY
        }

        // A second start command is how the open WebView supplies rotated auth
        // credentials. The existing GPS callback must remain single-instance.
        if (isRunning) {
            TrackingWatchdogReceiver.schedule(this)
            Log.i(TAG, "Tracking credentials updated without restarting GPS")
            return START_STICKY
        }

        val notif = buildNotification("Duty tracking active", "Acquiring GPS…")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIF_ID, notif)
        }

        startLocationUpdates()
        isRunning = true
        // Arm the watchdog so the service is revived if the OS/OEM later kills it.
        TrackingWatchdogReceiver.schedule(this)
        Log.i(TAG, "Tracking started (interval=${INTERVAL_MS}ms, minDist=${MIN_DIST_FILTER_M}m)")
        return START_STICKY
    }

    private fun startLocationUpdates() {
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVAL_MS)
            .setMinUpdateIntervalMillis(MIN_INTERVAL_MS)
            .setMaxUpdateDelayMillis(MAX_DELAY_MS)
            .setMinUpdateDistanceMeters(MIN_DIST_FILTER_M)
            .setWaitForAccurateLocation(false)
            .build()

        locationCallback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                for (loc in result.locations) onLocationReceived(loc)
            }
        }

        try {
            fusedLocationClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
        } catch (e: SecurityException) {
            Log.e(TAG, "Location permission revoked: ${e.message}"); stopSelf()
        }
    }

    private fun onLocationReceived(loc: Location) {
        if (!loc.hasAccuracy() || loc.accuracy > MAX_ACCURACY_M) {
            Log.d(TAG, "Ignoring weak GPS fix (accuracy=${loc.accuracy}m)")
            return
        }

        val prev = lastLocation
        if (prev != null) {
            val metres = prev.distanceTo(loc)
            val gapMs = loc.time - prev.time
            val noiseRadius = maxOf(
                MIN_VERIFIED_MOVE_M,
                minOf(100f, prev.accuracy + loc.accuracy + 10f)
            )

            // Tiny changes inside the combined accuracy radius are GPS drift,
            // not travel. Keep the stable coordinate for the heartbeat marker.
            if ((loc.hasSpeed() && loc.speed < 1.2f && metres < 500f) ||
                (metres < noiseRadius && (!loc.hasSpeed() || loc.speed < 1.2f))) return

            // A long outage starts a fresh segment; never invent the missing path.
            if (gapMs > MAX_GAP_MS) {
                lastLocation = loc
                pingCount++
                enqueueAndSend(loc, "signal_resumed")
                return
            }

            if (gapMs <= 0L || metres / (gapMs / 1000f) > MAX_SPEED_MPS) {
                Log.w(TAG, "Ignoring implausible GPS jump (${metres.toInt()}m in ${gapMs}ms)")
                return
            }
            totalDistanceKm += metres / 1000.0
        }
        lastLocation = loc
        pingCount++

        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
            .putFloat(KEY_DISTANCE_KM, totalDistanceKm.toFloat()).apply()

        val mins = ((System.currentTimeMillis() - startMs) / 60_000L).toInt()
        val durStr = if (mins < 60) "${mins}m" else "${mins / 60}h ${mins % 60}m"
        val statusLine = String.format(Locale.US, "%.2f km · %s · %d pts", totalDistanceKm, durStr, pingCount)
        updateNotification("Duty tracking active", statusLine)

        enqueueAndSend(loc, "moving")
    }

    private fun enqueueAndSend(loc: Location, activity: String) {
        val payload = JSONObject().apply {
            put("latitude",    loc.latitude)
            put("longitude",   loc.longitude)
            put("accuracy",    loc.accuracy)
            if (loc.hasSpeed())   put("speed",   loc.speed)
            if (loc.hasBearing()) put("heading", loc.bearing)
            put("battery_level", readBatteryLevel())
            put("activity",    activity)
            put("recorded_at", isoFmt.format(Date(loc.time.takeIf { it > 0 } ?: System.currentTimeMillis())))
        }
        pendingQueue.offer(payload)
        while (pendingQueue.size > MAX_QUEUE) pendingQueue.poll()
        lastPingMs = System.currentTimeMillis()
        netExecutor.execute { flushQueue() }
    }

    /** When the salesman is stationary the fused client stops delivering updates,
     *  which would make the dashboard show a growing "no signal" gap. Re-send the
     *  last known fix so they stay "live" until duty actually ends. */
    private fun heartbeatIfIdle() {
        val loc = lastLocation ?: return
        if (System.currentTimeMillis() - lastPingMs < HEARTBEAT_MS - 5_000L) return
        val payload = JSONObject().apply {
            put("latitude",    loc.latitude)
            put("longitude",   loc.longitude)
            put("accuracy",    loc.accuracy)
            put("battery_level", readBatteryLevel())
            put("activity",    "stationary")
            put("recorded_at", isoFmt.format(Date()))
        }
        pendingQueue.offer(payload)
        while (pendingQueue.size > MAX_QUEUE) pendingQueue.poll()
        lastPingMs = System.currentTimeMillis()
        flushQueue()
    }

    private fun flushQueue() {
        while (true) {
            val item = pendingQueue.peek() ?: break
            val ok = postPing(item)
            if (ok) {
                pendingQueue.poll()
            } else {
                persistQueue()
                return
            }
        }
        persistQueue()
    }

    private fun postPing(body: JSONObject): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            val url = URL("$baseUrl/api/v1/duty/location")
            conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 12_000
            conn.readTimeout    = 12_000
            conn.requestMethod  = "POST"
            conn.setRequestProperty("Content-Type",  "application/json")
            conn.setRequestProperty("Authorization", "Bearer $authToken")
            if (companyId.isNotEmpty())
                conn.setRequestProperty("x-company-id", companyId)
            conn.doOutput = true
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body.toString()) }
            val code = conn.responseCode
            Log.d(TAG, "Ping → HTTP $code  q=${pendingQueue.size}")
            if (code == HttpURLConnection.HTTP_UNAUTHORIZED && refreshAccessToken()) {
                postPingOnce(body)
            } else {
                code in 200..299
            }
        } catch (e: Exception) {
            Log.w(TAG, "Ping failed (queued): ${e.message}")
            false
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    /** Retry helper used only after a successful token rotation. */
    private fun postPingOnce(body: JSONObject): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("$baseUrl/api/v1/duty/location").openConnection() as HttpURLConnection).apply {
                connectTimeout = 12_000
                readTimeout = 12_000
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $authToken")
                if (companyId.isNotEmpty()) setRequestProperty("x-company-id", companyId)
                doOutput = true
            }
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body.toString()) }
            conn.responseCode in 200..299
        } catch (e: Exception) {
            Log.w(TAG, "Ping retry failed (queued): ${e.message}")
            false
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    /** Rotate the short-lived access token without requiring the WebView/app UI. */
    private fun refreshAccessToken(): Boolean {
        if (refreshToken.isEmpty()) return false
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("$baseUrl/api/v1/auth/refresh").openConnection() as HttpURLConnection).apply {
                connectTimeout = 12_000
                readTimeout = 12_000
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                doOutput = true
            }
            val request = JSONObject().put("refreshToken", refreshToken)
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(request.toString()) }
            if (conn.responseCode !in 200..299) return false
            val response = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val data = JSONObject(response).optJSONObject("data") ?: return false
            val newAccessToken = data.optString("accessToken", "")
            val newRefreshToken = data.optString("refreshToken", "")
            if (newAccessToken.isEmpty() || newRefreshToken.isEmpty()) return false

            authToken = newAccessToken
            refreshToken = newRefreshToken
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                .putString(KEY_TOKEN, authToken)
                .putString(KEY_REFRESH_TOKEN, refreshToken)
                .commit()
            Log.i(TAG, "Background auth session refreshed")
            true
        } catch (e: Exception) {
            Log.w(TAG, "Background auth refresh failed: ${e.message}")
            false
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    private fun persistQueue() {
        try {
            val arr = JSONArray()
            for (item in pendingQueue) arr.put(item)
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                .putString(KEY_PING_QUEUE, arr.toString()).apply()
        } catch (_: Exception) {}
    }

    private fun loadPendingQueue() {
        try {
            val raw = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .getString(KEY_PING_QUEUE, null) ?: return
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) pendingQueue.offer(arr.getJSONObject(i))
            Log.i(TAG, "Restored ${pendingQueue.size} queued pings")
        } catch (_: Exception) {}
    }

    private fun acquireWakeLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hometech:duty-tracking").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {}
    }

    private fun releaseWakeLock() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) {}
        wakeLock = null
    }

    private fun readBatteryLevel(): Int {
        val manager = getSystemService(BATTERY_SERVICE) as? BatteryManager
        return manager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
    }

    private fun buildNotification(title: String, text: String): Notification {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        else PendingIntent.FLAG_UPDATE_CURRENT

        val tap = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), flags
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(tap)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setWhen(startMs.takeIf { it > 0 } ?: SystemClock.elapsedRealtime())
            .setUsesChronometer(startMs > 0)
            .build()
    }

    private fun updateNotification(title: String, text: String) {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification(title, text))
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "GPS Duty Tracking", NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows while salesman duty is active"
                setShowBadge(false)
            }
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // App swiped away — keep service alive by re-launching ourselves.
        val restart = Intent(applicationContext, LocationTrackingService::class.java)
        ContextCompat.startForegroundService(applicationContext, restart)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        else PendingIntent.FLAG_UPDATE_CURRENT
        val restartPendingIntent = PendingIntent.getService(applicationContext, 2001, restart, flags)
        val alarmManager = applicationContext.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
        alarmManager?.set(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + 1000, restartPendingIntent)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        isRunning = false
        if (::locationCallback.isInitialized)
            fusedLocationClient.removeLocationUpdates(locationCallback)
        persistQueue()
        releaseWakeLock()
        try { netExecutor.shutdownNow() } catch (_: Exception) {}

        // Only wipe saved credentials when the salesman explicitly ended duty
        // via the JS bridge. If the OS killed the service (low memory etc.) we
        // must keep them so START_STICKY can restart tracking automatically.
        if (manualStopRequested) {
            manualStopRequested = false
            // Duty ended on purpose — stop the watchdog and wipe credentials so
            // nothing relaunches tracking.
            TrackingWatchdogReceiver.cancel(this)
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                .remove(KEY_TOKEN).remove(KEY_COMPANY).remove(KEY_BASE_URL)
                .remove(KEY_REFRESH_TOKEN)
                .remove(KEY_START_MS).remove(KEY_DISTANCE_KM).remove(KEY_PING_QUEUE)
                .apply()
            Log.i(TAG, "Tracking stopped (manual) — ${String.format("%.2f", totalDistanceKm)} km total")
        } else {
            // OS/OEM kill — leave credentials + watchdog in place so it restarts.
            Log.i(TAG, "Service destroyed by OS — credentials kept for auto-restart")
        }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
