package com.hometech.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.Granularity;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONObject;
import org.json.JSONArray;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class LocationForegroundService extends Service {

    private static final String TAG = "HomeTechLocation";
    // A new default-importance channel guarantees that Android shows the duty
    // tracking icon in the status bar. Older builds used a low-importance channel,
    // and Android never allows an installed channel's importance to be upgraded.
    private static final String CHANNEL_ID = "orderplus_duty_tracking_v2";
    // Version the channel because Android permanently remembers the importance of
    // an existing channel. A fresh ID guarantees heads-up alerts for users who
    // installed an older build where this channel may have been low priority.
    private static final String GPS_ALERT_CHANNEL_ID = "hometech_gps_alerts_v2";
    private static final int NOTIFICATION_ID = 1001;
    private static final int GPS_ALERT_NOTIFICATION_ID = 1002;

    // Intent action constants
    public static final String ACTION_START = "com.hometech.app.ACTION_START_TRACKING";
    public static final String ACTION_STOP  = "com.hometech.app.ACTION_STOP_TRACKING";

    // SharedPreferences key — plugin writes, service reads
    static final String PREFS_NAME  = "hometech_tracking";
    static final String KEY_TOKEN   = "auth_token";
    static final String KEY_REFRESH = "refresh_token";
    static final String KEY_COMPANY = "company_id";
    static final String KEY_USER    = "user_id";
    static final String KEY_ACTIVE  = "tracking_active";
    static final String KEY_QUEUE   = "offline_location_queue";

    // API base — matches the server URL in capacitor.config.ts
    private static final String API_BASE = "https://www.orderpluserp.in";

    // Ten-second high-accuracy fixes while duty is active. Android and the GPS
    // chipset may occasionally batch/delay a fix, so every point is queued before
    // upload and delivered as soon as connectivity is available.
    private static final long INTERVAL_MS          = 10_000L;
    private static final long FASTEST_INTERVAL_MS  = 8_000L;
    private static final long GPS_STATUS_CHECK_MS  = 5_000L;
    private static final long GPS_ALERT_INTERVAL_MS = 45_000L;
    private static final long HEALTH_REPORT_INTERVAL_MS = 45_000L;
    private static final float MIN_DISPLACEMENT_M  = 0f;
    private static final int MAX_QUEUED_PINGS      = 10_000;

    private FusedLocationProviderClient fusedClient;
    private LocationCallback locationCallback;
    private ExecutorService networkExecutor;
    private PowerManager.WakeLock trackingWakeLock;
    private final AtomicBoolean uploadInFlight = new AtomicBoolean(false);
    private final AtomicBoolean healthUploadInFlight = new AtomicBoolean(false);
    private final Object queueLock = new Object();
    private final Handler statusHandler = new Handler(Looper.getMainLooper());
    private long lastLocationAtMs = 0L;
    private long lastGpsAlertAtMs = 0L;
    private long lastHealthReportAtMs = 0L;
    private Boolean lastReportedGpsEnabled = null;
    private boolean statusMonitorRunning = false;
    private static volatile boolean serviceRunning = false;

    static boolean isServiceRunning() {
        return serviceRunning;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        serviceRunning = true;
        fusedClient = LocationServices.getFusedLocationProviderClient(this);
        networkExecutor = Executors.newSingleThreadExecutor();
        createNotificationChannel();
        createGpsAlertChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // Service restarted by OS after being killed — check if session was active
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            if (prefs.getBoolean(KEY_ACTIVE, false)) {
                startForegroundWithNotification();
                startLocationUpdates();
                startGpsStatusMonitor();
            } else {
                stopSelf();
            }
            return START_STICKY;
        }

        String action = intent.getAction();
        if (ACTION_START.equals(action)) {
            startForegroundWithNotification();
            startLocationUpdates();
            startGpsStatusMonitor();
        } else if (ACTION_STOP.equals(action)) {
            stopTracking();
        }

        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // App was swiped from recents — service keeps running because it's a foreground service.
        Log.i(TAG, "App removed from recents — location tracking continues in foreground service");
        
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        boolean isActive = prefs.getBoolean(KEY_ACTIVE, false);
        if (isActive) {
            // Schedule an immediate AlarmManager wakeup call to restart the service if killed by OS memory manager
            Intent restartServiceIntent = new Intent(getApplicationContext(), LocationForegroundService.class);
            restartServiceIntent.setAction(ACTION_START);
            int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                : PendingIntent.FLAG_UPDATE_CURRENT;
            PendingIntent restartPendingIntent = PendingIntent.getService(
                getApplicationContext(), 1, restartServiceIntent, flags);
            AlarmManager alarmService = (AlarmManager) getApplicationContext().getSystemService(Context.ALARM_SERVICE);
            if (alarmService != null) {
                alarmService.set(
                    AlarmManager.RTC_WAKEUP,
                    System.currentTimeMillis() + 1000,
                    restartPendingIntent
                );
            }
        }
        super.onTaskRemoved(rootIntent);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null; // Not a bound service
    }

    @Override
    public void onDestroy() {
        serviceRunning = false;
        stopLocationUpdates();
        stopGpsStatusMonitor();
        releaseTrackingWakeLock();
        if (networkExecutor != null) networkExecutor.shutdownNow();
        super.onDestroy();
    }

    // ── Foreground notification ────────────────────────────────────────────────

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Duty GPS Tracking",
                NotificationManager.IMPORTANCE_DEFAULT
            );
            channel.setDescription("Persistent status-bar notification while duty GPS tracking is active");
            channel.setShowBadge(false);
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private void createGpsAlertChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                GPS_ALERT_CHANNEL_ID,
                "GPS Required Alerts",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Alerts when device location is disabled during duty");
            channel.setShowBadge(true);
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[] { 0L, 350L, 180L, 350L });
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        // Tap the notification to bring app back to foreground
        Intent openApp = new Intent(this, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent openIntent = PendingIntent.getActivity(this, 0, openApp, flags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Order Plus ERP — Duty GPS active")
            .setContentText("Your location is being recorded every 10 seconds.")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)           // Cannot be dismissed by the user
            .setSilent(true)            // No sound or vibration
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build();
    }

    private void startForegroundWithNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIFICATION_ID, buildNotification());
        }
        acquireTrackingWakeLock();
    }

    // ── Location updates ───────────────────────────────────────────────────────

    private void startLocationUpdates() {
        stopLocationUpdates();

        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVAL_MS)
            .setMinUpdateIntervalMillis(FASTEST_INTERVAL_MS)
            .setMaxUpdateDelayMillis(INTERVAL_MS)
            .setMinUpdateDistanceMeters(MIN_DISPLACEMENT_M)
            .setGranularity(Granularity.GRANULARITY_FINE)
            .setWaitForAccurateLocation(false)
            .build();

        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                if (result == null || result.getLastLocation() == null) return;
                android.location.Location loc = result.getLastLocation();
                onNewLocation(loc.getLatitude(), loc.getLongitude(),
                    loc.getAccuracy(), loc.getSpeed(), loc.getBearing());
            }
        };

        try {
            fusedClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper());
            Log.i(TAG, "Location updates started");
        } catch (SecurityException e) {
            Log.e(TAG, "Location permission missing: " + e.getMessage());
        }
    }

    private void stopLocationUpdates() {
        if (fusedClient != null && locationCallback != null) {
            fusedClient.removeLocationUpdates(locationCallback);
            locationCallback = null;
        }
    }

    private void stopTracking() {
        stopLocationUpdates();
        stopGpsStatusMonitor();
        cancelGpsAlert();
        releaseTrackingWakeLock();
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit().putBoolean(KEY_ACTIVE, false).apply();
        stopForeground(true);
        stopSelf();
        Log.i(TAG, "Location tracking stopped");
    }

    // ── Network: POST location to API ─────────────────────────────────────────

    private void onNewLocation(double lat, double lng, float accuracy, float speed, float bearing) {
        lastLocationAtMs = System.currentTimeMillis();
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (prefs.getString(KEY_TOKEN, null) == null) {
            Log.w(TAG, "No auth token — retaining tracking service until credentials return");
            return;
        }

        JSONObject body = new JSONObject();
        try {
            String recordedAt = isoNow();
            body.put("latitude", lat);
            body.put("longitude", lng);
            body.put("accuracy", accuracy);
            body.put("speed", speed);
            body.put("heading", bearing);
            body.put("battery_level", readBatteryLevel());
            body.put("activity", "moving");
            body.put("recorded_at", recordedAt);
            body.put("queued_at", recordedAt);
            // Persist first. If the network is slow, later GPS callbacks do not pile
            // up as in-memory executor tasks and are safe across process restarts.
            enqueuePing(body);
            flushQueuedPings();
        } catch (Exception e) {
            Log.w(TAG, "Could not queue location ping: " + e.getMessage());
        }
    }

    // ── GPS health monitoring ────────────────────────────────────────────────

    private final Runnable gpsStatusRunnable = new Runnable() {
        @Override
        public void run() {
            if (!statusMonitorRunning) return;
            checkGpsHealth();
            statusHandler.postDelayed(this, GPS_STATUS_CHECK_MS);
        }
    };

    private void startGpsStatusMonitor() {
        if (statusMonitorRunning) return;
        statusMonitorRunning = true;
        statusHandler.removeCallbacks(gpsStatusRunnable);
        statusHandler.post(gpsStatusRunnable);
    }

    private void stopGpsStatusMonitor() {
        statusMonitorRunning = false;
        statusHandler.removeCallbacks(gpsStatusRunnable);
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isGpsEnabled() {
        LocationManager manager = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return manager.isLocationEnabled();
        try {
            return manager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception ignored) {
            return false;
        }
    }

    private void checkGpsHealth() {
        boolean permissionGranted = hasLocationPermission();
        boolean gpsEnabled = permissionGranted && isGpsEnabled();
        long now = System.currentTimeMillis();

        if (!gpsEnabled) {
            if (now - lastGpsAlertAtMs >= GPS_ALERT_INTERVAL_MS) {
                showGpsOffAlert();
                lastGpsAlertAtMs = now;
            }
        } else {
            cancelGpsAlert();
            lastGpsAlertAtMs = 0L;
        }

        boolean statusChanged = lastReportedGpsEnabled == null || lastReportedGpsEnabled != gpsEnabled;
        if (statusChanged || now - lastHealthReportAtMs >= HEALTH_REPORT_INTERVAL_MS) {
            reportGpsHealth(gpsEnabled, permissionGranted);
            lastReportedGpsEnabled = gpsEnabled;
            lastHealthReportAtMs = now;
        }
    }

    private void showGpsOffAlert() {
        Intent settingsIntent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
        settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent settingsPendingIntent = PendingIntent.getActivity(this, 22, settingsIntent, flags);

        Notification alert = new NotificationCompat.Builder(this, GPS_ALERT_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("GPS is off while you are on duty")
            .setContentText("Turn on GPS now to continue verified duty tracking.")
            .setStyle(new NotificationCompat.BigTextStyle()
                .bigText("Your GPS location is turned off. Please turn it on while you are on duty. This warning repeats every 45 seconds until GPS is restored."))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setDefaults(Notification.DEFAULT_ALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(false)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .setAutoCancel(false)
            .setContentIntent(settingsPendingIntent)
            .addAction(android.R.drawable.ic_menu_mylocation, "Turn on GPS", settingsPendingIntent)
            .build();

        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            // Re-post as a fresh alert so Android produces a heads-up notification
            // on every 45-second warning instead of treating it as a silent update.
            manager.cancel(GPS_ALERT_NOTIFICATION_ID);
            manager.notify(GPS_ALERT_NOTIFICATION_ID, alert);
        }
    }

    private void cancelGpsAlert() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(GPS_ALERT_NOTIFICATION_ID);
    }

    private void reportGpsHealth(boolean gpsEnabled, boolean permissionGranted) {
        if (networkExecutor == null || networkExecutor.isShutdown()) return;
        if (!healthUploadInFlight.compareAndSet(false, true)) return;
        networkExecutor.execute(() -> {
            try {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String token = prefs.getString(KEY_TOKEN, null);
                String companyId = prefs.getString(KEY_COMPANY, null);
                if (token != null) postGpsHealth(gpsEnabled, permissionGranted, token, companyId, true);
            } finally {
                healthUploadInFlight.set(false);
            }
        });
    }

    private boolean postGpsHealth(
        boolean gpsEnabled,
        boolean permissionGranted,
        String authToken,
        @Nullable String companyId,
        boolean allowRefresh
    ) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(API_BASE + "/api/v1/duty/gps-health");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + authToken);
            if (companyId != null && !companyId.isEmpty()) conn.setRequestProperty("x-company-id", companyId);
            conn.setDoOutput(true);
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(10_000);

            JSONObject body = new JSONObject();
            body.put("gps_enabled", gpsEnabled);
            body.put("permission_granted", permissionGranted);
            body.put("service_active", true);
            body.put("location_available", lastLocationAtMs > 0L);
            if (lastLocationAtMs > 0L) {
                body.put("last_location_at", isoFromMillis(lastLocationAtMs));
            }
            body.put("device_platform", "android");

            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            if (code == HttpURLConnection.HTTP_UNAUTHORIZED && allowRefresh) {
                String refreshedToken = refreshAccessToken();
                return refreshedToken != null && postGpsHealth(
                    gpsEnabled, permissionGranted, refreshedToken, companyId, false
                );
            }
            return code >= 200 && code < 300;
        } catch (Exception error) {
            Log.w(TAG, "GPS health upload failed: " + error.getMessage());
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void flushQueuedPings() {
        if (networkExecutor == null || networkExecutor.isShutdown()) return;
        if (!uploadInFlight.compareAndSet(false, true)) return;

        networkExecutor.execute(() -> {
            try {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String token = prefs.getString(KEY_TOKEN, null);
                String companyId = prefs.getString(KEY_COMPANY, null);
                if (token != null) drainQueuedPings(token, companyId);
            } finally {
                uploadInFlight.set(false);
            }
        });
    }

    private boolean postLocation(JSONObject body, String authToken, @Nullable String companyId) {
        return postLocation(body, authToken, companyId, true);
    }

    private boolean postLocation(JSONObject body, String authToken, @Nullable String companyId, boolean allowRefresh) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(API_BASE + "/api/v1/duty/location");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type",   "application/json");
            conn.setRequestProperty("Authorization",  "Bearer " + authToken);
            if (companyId != null && !companyId.isEmpty()) conn.setRequestProperty("x-company-id", companyId);
            conn.setDoOutput(true);
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(10_000);

            byte[] bodyBytes = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bodyBytes);
            }

            int code = conn.getResponseCode();
            if (code == HttpURLConnection.HTTP_UNAUTHORIZED && allowRefresh) {
                String refreshedToken = refreshAccessToken();
                return refreshedToken != null && postLocation(body, refreshedToken, companyId, false);
            }
            return code >= 200 && code < 300;
        } catch (Exception e) {
            Log.w(TAG, "postLocation failed: " + e.getMessage());
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** Refreshes the Supabase session without requiring the WebView/app to reopen. */
    @Nullable
    private String refreshAccessToken() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String refreshToken = prefs.getString(KEY_REFRESH, null);
        if (refreshToken == null || refreshToken.isEmpty()) return null;

        HttpURLConnection conn = null;
        try {
            URL url = new URL(API_BASE + "/api/v1/auth/refresh");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(10_000);

            JSONObject request = new JSONObject();
            request.put("refreshToken", refreshToken);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(request.toString().getBytes(StandardCharsets.UTF_8));
            }

            if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300) return null;
            InputStream stream = conn.getInputStream();
            StringBuilder response = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) response.append(line);
            }
            JSONObject data = new JSONObject(response.toString()).optJSONObject("data");
            if (data == null) return null;
            String accessToken = data.optString("accessToken", "");
            String nextRefreshToken = data.optString("refreshToken", refreshToken);
            if (accessToken.isEmpty()) return null;

            prefs.edit()
                .putString(KEY_TOKEN, accessToken)
                .putString(KEY_REFRESH, nextRefreshToken)
                .apply();
            Log.i(TAG, "Background tracking session refreshed");
            return accessToken;
        } catch (Exception e) {
            Log.w(TAG, "Session refresh failed: " + e.getMessage());
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void enqueuePing(JSONObject body) {
        synchronized (queueLock) {
            try {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                JSONArray queue = new JSONArray(prefs.getString(KEY_QUEUE, "[]"));
                queue.put(body);
                while (queue.length() > MAX_QUEUED_PINGS) queue.remove(0);
                prefs.edit().putString(KEY_QUEUE, queue.toString()).commit();
            } catch (Exception e) {
                Log.w(TAG, "Failed to queue location ping: " + e.getMessage());
            }
        }
    }

    private void drainQueuedPings(String authToken, @Nullable String companyId) {
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            JSONArray queue;
            synchronized (queueLock) {
                queue = new JSONArray(prefs.getString(KEY_QUEUE, "[]"));
            }
            if (queue.length() == 0) return;

            int sentCount = 0;
            for (int i = 0; i < queue.length(); i++) {
                JSONObject queued = queue.getJSONObject(i);
                String currentToken = prefs.getString(KEY_TOKEN, authToken);
                if (!postLocation(queued, currentToken, companyId)) {
                    break;
                }
                sentCount++;
            }

            if (sentCount > 0) {
                // Preserve points appended by a GPS callback while this network batch
                // was uploading; remove only the prefix confirmed by the server.
                synchronized (queueLock) {
                    JSONArray current = new JSONArray(prefs.getString(KEY_QUEUE, "[]"));
                    JSONArray remaining = new JSONArray();
                    for (int i = Math.min(sentCount, current.length()); i < current.length(); i++) {
                        remaining.put(current.getJSONObject(i));
                    }
                    prefs.edit().putString(KEY_QUEUE, remaining.toString()).commit();
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to drain location queue: " + e.getMessage());
        }
    }

    private String isoNow() {
        return isoFromMillis(System.currentTimeMillis());
    }

    private String isoFromMillis(long timestampMs) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return java.time.Instant.ofEpochMilli(timestampMs).toString();
        }
        java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        sdf.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return sdf.format(new java.util.Date(timestampMs));
    }

    private int readBatteryLevel() {
        BatteryManager manager = (BatteryManager) getSystemService(BATTERY_SERVICE);
        return manager == null ? -1 : manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
    }

    private void acquireTrackingWakeLock() {
        if (trackingWakeLock != null && trackingWakeLock.isHeld()) return;
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        if (manager == null) return;
        trackingWakeLock = manager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "HomeTechCRM:ActiveDutyLocation"
        );
        trackingWakeLock.setReferenceCounted(false);
        trackingWakeLock.acquire();
    }

    private void releaseTrackingWakeLock() {
        if (trackingWakeLock != null && trackingWakeLock.isHeld()) {
            trackingWakeLock.release();
        }
        trackingWakeLock = null;
    }
}
