package com.hometech.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import static com.hometech.app.LocationForegroundService.KEY_ACTIVE;
import static com.hometech.app.LocationForegroundService.PREFS_NAME;

public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "HomeTechBootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;

        String action = intent.getAction();
        boolean bootCompleted =
            Intent.ACTION_BOOT_COMPLETED.equals(action) ||
            "android.intent.action.QUICKBOOT_POWERON".equals(action);
        if (!bootCompleted) return;

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_ACTIVE, false)) return;

        Intent serviceIntent = new Intent(context, LocationForegroundService.class);
        serviceIntent.setAction(LocationForegroundService.ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent);
        } else {
            context.startService(serviceIntent);
        }
        Log.i(TAG, "Restarted active location tracking after boot");
    }
}
