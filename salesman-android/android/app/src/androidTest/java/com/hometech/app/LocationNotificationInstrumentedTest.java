package com.hometech.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.Manifest;
import android.app.Activity;
import android.app.Instrumentation;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;

import androidx.core.content.ContextCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class LocationNotificationInstrumentedTest {

    @Test
    public void gpsOffShowsPersistentDutyAndGpsWarningNotifications() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        String packageName = context.getPackageName();
        Activity activity = null;

        instrumentation.getUiAutomation().grantRuntimePermission(
            packageName, Manifest.permission.ACCESS_FINE_LOCATION
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            instrumentation.getUiAutomation().grantRuntimePermission(
                packageName, Manifest.permission.POST_NOTIFICATIONS
            );
        }

        try {
            Intent launchIntent = context.getPackageManager().getLaunchIntentForPackage(packageName);
            assertNotNull(launchIntent);
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity = instrumentation.startActivitySync(launchIntent);
            instrumentation.waitForIdleSync();

            setLocationEnabled(instrumentation, false);
            context.getSharedPreferences(LocationForegroundService.PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(LocationForegroundService.KEY_ACTIVE, true)
                .putString(LocationForegroundService.KEY_TOKEN, "instrumented-test-token")
                .apply();

            Intent serviceIntent = new Intent(context, LocationForegroundService.class);
            serviceIntent.setAction(LocationForegroundService.ACTION_START);
            ContextCompat.startForegroundService(context, serviceIntent);
            SystemClock.sleep(7_000L);

            NotificationManager manager = context.getSystemService(NotificationManager.class);
            assertNotNull(manager);
            StatusBarNotification dutyNotification = findNotification(manager, 1001);
            StatusBarNotification gpsWarning = findNotification(manager, 1002);

            assertNotNull("Persistent duty tracking notification is missing", dutyNotification);
            assertNotNull("GPS-off warning notification is missing", gpsWarning);
            assertEquals("orderplus_duty_tracking_v2", dutyNotification.getNotification().getChannelId());
            assertEquals("hometech_gps_alerts_v2", gpsWarning.getNotification().getChannelId());
            assertTrue((dutyNotification.getNotification().flags & Notification.FLAG_ONGOING_EVENT) != 0);
            assertEquals(
                "Order Plus ERP — Duty GPS active",
                String.valueOf(dutyNotification.getNotification().extras.getCharSequence(Notification.EXTRA_TITLE))
            );
            assertEquals(
                "GPS is off while you are on duty",
                String.valueOf(gpsWarning.getNotification().extras.getCharSequence(Notification.EXTRA_TITLE))
            );

            // Closing the app screen must not stop the duty service or either notification.
            activity.finish();
            activity = null;
            instrumentation.waitForIdleSync();
            SystemClock.sleep(2_000L);

            assertTrue("Duty service stopped when the app screen closed", LocationForegroundService.isServiceRunning());
            assertNotNull(
                "Persistent duty notification disappeared when the app screen closed",
                findNotification(manager, 1001)
            );
            assertNotNull(
                "GPS-off warning disappeared when the app screen closed",
                findNotification(manager, 1002)
            );
        } finally {
            Intent stopIntent = new Intent(context, LocationForegroundService.class);
            stopIntent.setAction(LocationForegroundService.ACTION_STOP);
            context.startService(stopIntent);
            setLocationEnabled(instrumentation, true);
            if (activity != null) activity.finish();
        }
    }

    private static StatusBarNotification findNotification(NotificationManager manager, int id) {
        for (StatusBarNotification notification : manager.getActiveNotifications()) {
            if (notification.getId() == id) return notification;
        }
        return null;
    }

    private static void setLocationEnabled(Instrumentation instrumentation, boolean enabled) {
        String command = "cmd location set-location-enabled " + enabled;
        try (ParcelFileDescriptor ignored = instrumentation.getUiAutomation().executeShellCommand(command)) {
            SystemClock.sleep(1_000L);
        } catch (Exception error) {
            throw new AssertionError("Unable to change Android Location state", error);
        }
    }
}
