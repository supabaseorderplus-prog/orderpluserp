# Order Plus ERP Android App

Native Android WebView wrapper for the Order Plus ERP web application.

## Prerequisites

- [Android Studio](https://developer.android.com/studio) (Hedgehog or newer)
- JDK 17 (bundled with Android Studio)
- Android SDK API 34
- Your Order Plus ERP web app deployed to a public URL **or** running locally

---

## Step 1 — Set the app URL

Open `app/src/main/java/com/hometech/app/MainActivity.kt` and update line:

```kotlin
const val APP_URL = "https://www.orderpluserp.in"
```

- **Production**: the verified domain, `https://www.orderpluserp.in`
- **Local dev** (phone + Mac on same WiFi):
  ```kotlin
  const val APP_URL = "http://192.168.1.X:3000"
  ```
  Find your Mac IP: System Preferences → Network → Wi-Fi → IP Address

  For local dev, also uncomment the domain in `app/src/main/res/xml/network_security_config.xml`.

---

## Step 2 — Open in Android Studio

1. Open Android Studio
2. Click **Open** → select this `android-app/` folder
3. Wait for Gradle sync to complete

---

## Step 3 — Create local.properties

Copy `local.properties.example` to `local.properties`:
```
sdk.dir=/Users/sahil/Library/Android/sdk
```
Android Studio usually creates this automatically.

---

## Step 4 — Build & Run

### On a physical device (recommended):
1. Enable **Developer Options** on your Android phone
2. Enable **USB Debugging**
3. Connect via USB
4. Click the ▶ **Run** button in Android Studio

### Build a Debug APK (for sharing/testing):
```
Build → Build Bundle(s)/APK(s) → Build APK(s)
```
APK location: `app/build/outputs/apk/debug/app-debug.apk`

### Build a Release APK (for Play Store):
```
Build → Generate Signed Bundle/APK → APK
```
Create a keystore on first run and save it safely.

---

## Features

| Feature | Status |
|---|---|
| Full web app in WebView | ✅ |
| Back button navigation | ✅ |
| Pull-to-refresh | ✅ |
| GPS / Location access | ✅ |
| Camera + photo upload via system picker | ✅ |
| File picker (gallery, no broad media permission) | ✅ |
| No-internet offline screen | ✅ |
| Splash screen | ✅ |
| HTTPS only (cleartext blocked) | ✅ |
| Remote debugging (debug build) | ✅ |

---

## Permissions (AndroidManifest.xml)

| Permission | Purpose |
|---|---|
| INTERNET | Load the web app |
| ACCESS_FINE/COARSE_LOCATION | GPS tracking for salesman routes |
| ACCESS_BACKGROUND_LOCATION | Background GPS (Android 10+) |
| WAKE_LOCK | Keep GPS active in background |
| POST_NOTIFICATIONS | Push notifications |

---

## Troubleshooting

**Blank white screen**: The `APP_URL` in `MainActivity.kt` is wrong or the server isn't reachable.

**Cleartext traffic error**: You're using `http://` for production. Either deploy to HTTPS or uncomment the domain in `network_security_config.xml`.

**Location not working**: Accept the permission prompt that appears on first launch.

**Can't upload photos**: Make sure a camera or gallery app is installed. Photo selection is delegated to Android's secure system picker and does not require broad gallery access.
