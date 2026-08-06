package com.hometech.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import static com.hometech.app.LocationForegroundService.KEY_ACTIVE;
import static com.hometech.app.LocationForegroundService.KEY_COMPANY;
import static com.hometech.app.LocationForegroundService.KEY_REFRESH;
import static com.hometech.app.LocationForegroundService.KEY_TOKEN;
import static com.hometech.app.LocationForegroundService.KEY_USER;
import static com.hometech.app.LocationForegroundService.PREFS_NAME;

@CapacitorPlugin(
    name = "BackgroundLocation",
    permissions = {
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION   }, alias = "location"),
        @Permission(strings = { Manifest.permission.ACCESS_COARSE_LOCATION }, alias = "coarseLocation"),
        @Permission(strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }, alias = "backgroundLocation"),
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications"),
    }
)
public class BackgroundLocationPlugin extends Plugin {

    private static final String TAG = "HomeTechBGPlugin";
    private static final String GPS_ALERT_CHANNEL_ID = "hometech_gps_alerts_v2";
    private static final String APP_EVENT_CHANNEL_ID = "orderplus_app_events";
    private static final int GPS_ALERT_NOTIFICATION_ID = 1002;
    private static final int LOGIN_NOTIFICATION_ID = 1100;

    // Stored to resolve after runtime permission grant
    private PluginCall pendingStartCall;

    /**
     * Called by JavaScript: BackgroundLocation.startTracking({ authToken, companyId, userId })
     *
     * Saves credentials to SharedPreferences (so the Service can read them even if
     * the WebView process is dead), then starts the foreground service.
     */
    @PluginMethod
    public void startTracking(PluginCall call) {
        String authToken  = call.getString("authToken");
        String refreshToken = call.getString("refreshToken", "");
        String companyId  = call.getString("companyId", "");
        String userId     = call.getString("userId",    "");

        if (authToken == null || authToken.isEmpty()) {
            call.reject("authToken is required");
            return;
        }

        // Persist credentials so the service can access them independently of the WebView
        SharedPreferences.Editor prefs = getContext()
            .getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
            .edit();
        prefs.putString(KEY_TOKEN,   authToken);
        prefs.putString(KEY_REFRESH, refreshToken);
        prefs.putString(KEY_COMPANY, companyId);
        prefs.putString(KEY_USER,    userId);
        prefs.apply();

        pendingStartCall = call;

        // Ask for every runtime permission needed by the active-duty service.
        if (!hasFineLocationPermission()) {
            requestPermissionForAlias("location", call, "locationPermissionCallback");
            return;
        }

        continueStartAfterLocationPermission(call);
    }

    /**
     * Called by JavaScript: BackgroundLocation.stopTracking()
     *
     * Stops the foreground service and clears the active-session flag.
     */
    @PluginMethod
    public void stopTracking(PluginCall call) {
        getContext()
            .getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_ACTIVE, false).apply();

        Intent stopIntent = new Intent(getContext(), LocationForegroundService.class);
        stopIntent.setAction(LocationForegroundService.ACTION_STOP);
        getContext().startService(stopIntent);

        Log.i(TAG, "stopTracking called from JavaScript");
        call.resolve();
    }

    /**
     * Called by JavaScript: BackgroundLocation.isTracking()
     * Returns { active: true/false }
     */
    @PluginMethod
    public void isTracking(PluginCall call) {
        boolean active = LocationForegroundService.isServiceRunning();
        JSObject result = new JSObject();
        result.put("active", active);
        result.put("requested", getContext()
            .getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
            .getBoolean(KEY_ACTIVE, false));
        call.resolve(result);
    }

    /** Returns every prerequisite used by the duty pre-flight screen. */
    @PluginMethod
    public void getGpsStatus(PluginCall call) {
        call.resolve(reliabilityStatus());
    }

    /** Opens Android's device-level Location Services screen. */
    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to open GPS settings: " + error.getMessage());
        }
    }

    /** Opens this app's Android notification settings when alerts were blocked. */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            } else {
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to open notification settings: " + error.getMessage());
        }
    }

    /** Allows the signed-in WebView monitor to warn even before duty starts. */
    @PluginMethod
    public void showGpsOffWarning(PluginCall call) {
        createGpsAlertChannel();
        Intent settingsIntent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
        settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent settingsPendingIntent = PendingIntent.getActivity(
            getContext(), 23, settingsIntent, flags
        );

        Notification alert = new NotificationCompat.Builder(getContext(), GPS_ALERT_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("GPS is off while you are on duty")
            .setContentText("Turn on GPS now to continue verified duty tracking.")
            .setStyle(new NotificationCompat.BigTextStyle().bigText(
                "Your GPS location is turned off. Please turn it on while you are on duty."
            ))
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

        NotificationManager manager = (NotificationManager) getContext()
            .getSystemService(android.content.Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel(GPS_ALERT_NOTIFICATION_ID);
            manager.notify(GPS_ALERT_NOTIFICATION_ID, alert);
        }
        call.resolve();
    }

    /** Shows a native Android confirmation immediately after a successful mobile login. */
    @PluginMethod
    public void showLoginNotification(PluginCall call) {
        if (!hasNotificationPermission()) {
            requestPermissionForAlias("notifications", call, "loginNotificationPermissionCallback");
            return;
        }
        showLoginNotificationNow(call);
    }

    /** Displays an in-app event as a native Android notification when available. */
    @PluginMethod
    public void showAppNotification(PluginCall call) {
        if (!hasNotificationPermission()) {
            JSObject result = new JSObject();
            result.put("shown", false);
            result.put("reason", "notification_permission_denied");
            call.resolve(result);
            return;
        }
        createAppEventChannel();
        String title = call.getString("title", "Order Plus ERP");
        String message = call.getString("message", "You have a new notification.");
        Integer requestedId = call.getInt("notificationId");
        int notificationId = requestedId != null ? requestedId : (1200 + Math.abs(message.hashCode() % 100_000));

        NotificationManager manager = (NotificationManager) getContext()
            .getSystemService(android.content.Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(notificationId, buildAppEventNotification(title, message));

        JSObject result = new JSObject();
        result.put("shown", manager != null);
        call.resolve(result);
    }

    /**
     * Called by JavaScript: BackgroundLocation.requestBackgroundPermission()
     *
     * On Android 10+ the user must explicitly grant "Allow all the time" for background
     * location. This method opens the system permission dialog for that.
     */
    @PluginMethod
    public void requestBackgroundPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Pre-Android 10 — background location not a separate permission
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }

        int status = ContextCompat.checkSelfPermission(
            getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION);
        if (status == PackageManager.PERMISSION_GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }

        // Request the background location permission (shows "Allow all the time" when supported)
        requestPermissionForAlias("backgroundLocation", call, "backgroundPermissionCallback");
    }

    /**
     * Requests Android's battery-optimization exemption for an active field-duty
     * tracker. The user still controls the system confirmation dialog.
     */
    @PluginMethod
    public void requestReliabilityPermissions(PluginCall call) {
        boolean alreadyExempt = isIgnoringBatteryOptimizations();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !alreadyExempt) {
            try {
                Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            } catch (Exception directRequestError) {
                Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            }
        }

        JSObject result = reliabilityStatus();
        result.put("batteryDialogOpened", !alreadyExempt);
        call.resolve(result);
    }

    @PluginMethod
    public void getReliabilityStatus(PluginCall call) {
        call.resolve(reliabilityStatus());
    }

    // ── Permission callbacks ───────────────────────────────────────────────────

    @PermissionCallback
    private void locationPermissionCallback(PluginCall call) {
        if (hasFineLocationPermission()) {
            continueStartAfterLocationPermission(call);
        } else {
            call.reject("Location permission denied. Please grant location access to track duty.");
            pendingStartCall = null;
        }
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        if (hasNotificationPermission()) {
            launchService(call);
        } else {
            getContext().getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_ACTIVE, false).apply();
            call.reject("Notification permission is required so GPS-off duty warnings can be delivered.");
        }
        pendingStartCall = null;
    }

    @PermissionCallback
    private void loginNotificationPermissionCallback(PluginCall call) {
        showLoginNotificationNow(call);
    }

    @PermissionCallback
    private void backgroundPermissionCallback(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(
                getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION
            ) == PackageManager.PERMISSION_GRANTED;

        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private boolean hasFineLocationPermission() {
        return ContextCompat.checkSelfPermission(
            getContext(), Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasNotificationPermission() {
        boolean runtimeGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(
                getContext(), Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED;
        return runtimeGranted && NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
    }

    private boolean isLocationServicesEnabled() {
        LocationManager manager = (LocationManager) getContext()
            .getSystemService(android.content.Context.LOCATION_SERVICE);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return manager.isLocationEnabled();
        try {
            return manager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception ignored) {
            return false;
        }
    }

    private void continueStartAfterLocationPermission(PluginCall call) {
        boolean resumeActiveDuty = Boolean.TRUE.equals(call.getBoolean("resumeActiveDuty", false));
        if (!isLocationServicesEnabled() && !resumeActiveDuty) {
            getContext().getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_ACTIVE, false).apply();
            try {
                Intent intent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            } catch (Exception ignored) {
                // The caller still receives an actionable rejection below.
            }
            call.reject("GPS is turned off. Turn on Location Services before starting duty.");
            pendingStartCall = null;
            return;
        }
        requestNotificationPermissionOrLaunch(call);
    }

    private void requestNotificationPermissionOrLaunch(PluginCall call) {
        if (!hasNotificationPermission()) {
            requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
            return;
        }
        launchService(call);
        pendingStartCall = null;
    }

    private boolean isIgnoringBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager manager = (PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
        return manager != null && manager.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    private JSObject reliabilityStatus() {
        JSObject result = new JSObject();
        boolean active = LocationForegroundService.isServiceRunning();
        result.put("locationServicesEnabled", isLocationServicesEnabled());
        result.put("fineLocationGranted", hasFineLocationPermission());
        result.put("backgroundLocationGranted",
            Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || ContextCompat.checkSelfPermission(
                getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION
            ) == PackageManager.PERMISSION_GRANTED);
        result.put("notificationsGranted", hasNotificationPermission());
        result.put("batteryOptimizationDisabled", isIgnoringBatteryOptimizations());
        result.put("trackingActive", active);
        result.put("trackingRequested", getContext()
            .getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
            .getBoolean(KEY_ACTIVE, false));
        return result;
    }

    private void createGpsAlertChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                GPS_ALERT_CHANNEL_ID,
                "GPS Required Alerts",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Alerts when device location is disabled");
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[] { 0L, 350L, 180L, 350L });
            NotificationManager manager = (NotificationManager) getContext()
                .getSystemService(android.content.Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private void createAppEventChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                APP_EVENT_CHANNEL_ID,
                "Order Plus Notifications",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Login confirmations and important company alerts");
            channel.enableVibration(true);
            NotificationManager manager = (NotificationManager) getContext()
                .getSystemService(android.content.Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private PendingIntent openAppPendingIntent(int requestCode) {
        Intent openApp = new Intent(getContext(), MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getActivity(getContext(), requestCode, openApp, flags);
    }

    private Notification buildAppEventNotification(String title, String message) {
        return new NotificationCompat.Builder(getContext(), APP_EVENT_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setDefaults(Notification.DEFAULT_ALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setContentIntent(openAppPendingIntent(31))
            .build();
    }

    private void showLoginNotificationNow(PluginCall call) {
        if (!hasNotificationPermission()) {
            JSObject result = new JSObject();
            result.put("shown", false);
            result.put("reason", "notification_permission_denied");
            call.resolve(result);
            return;
        }
        createAppEventChannel();
        String userName = call.getString("userName", "your account");
        String message = "You are logged in as " + userName + ". Important duty alerts will appear here.";
        NotificationManager manager = (NotificationManager) getContext()
            .getSystemService(android.content.Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(LOGIN_NOTIFICATION_ID, buildAppEventNotification("Login successful", message));
        JSObject result = new JSObject();
        result.put("shown", manager != null);
        call.resolve(result);
    }

    private void launchService(PluginCall call) {
        try {
            getContext().getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_ACTIVE, true).apply();
            Intent startIntent = new Intent(getContext(), LocationForegroundService.class);
            startIntent.setAction(LocationForegroundService.ACTION_START);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(startIntent);
            } else {
                getContext().startService(startIntent);
            }
            Log.i(TAG, "LocationForegroundService started");
            call.resolve();
        } catch (Exception e) {
            getContext().getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_ACTIVE, false).apply();
            Log.e(TAG, "Failed to start service: " + e.getMessage());
            call.reject("Failed to start background tracking: " + e.getMessage());
        }
    }
}
