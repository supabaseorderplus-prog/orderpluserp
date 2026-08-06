# Order Plus ERP Android App

Native Android app for the Order Plus ERP portal, built with Capacitor (WebView wrapper).

## Prerequisites

- [Android Studio](https://developer.android.com/studio) + JDK 17
- Node.js (v18+) or Bun
- The Next.js web app deployed to a publicly accessible URL **or** running on your local network

## Setup

### 1. Install dependencies

```bash
cd salesman-android
npm install
```

### 2. Configure the server URL

Edit `capacitor.config.ts` and set `server.url` to:

**For local testing (device on same WiFi):**
```ts
url: 'http://192.168.X.X:3000/salesman',
cleartext: true,
```
Find your Mac's IP: `System Preferences → Network → Wi-Fi → IP Address`

**For production:**
```ts
url: 'https://your-deployed-domain.com/salesman',
cleartext: false,
```
Also set `allowMixedContent: false` for production.

### 3. Sync the Android project

```bash
npm install
npx cap sync android
```

### 4. Open in Android Studio

```bash
npx cap open android
```

### 5. Build the APK

In Android Studio:
- **Debug APK**: `Build → Build Bundle(s)/APK(s) → Build APK(s)`
- **Release APK**: `Build → Generate Signed Bundle/APK → APK → (create keystore)`

The APK will be at:
`android/app/build/outputs/apk/debug/app-debug.apk`

## App Behaviour

- Opens directly to the **Salesman login page** (`/salesman`)
- Only users with `SALESMAN` role can log in — other roles are blocked with an error
- After login, redirects to the salesman dashboard
- Starting duty launches a persistent foreground location service
- High-accuracy fixes are requested about every 3 seconds while duty is active
- Swiping the app from Recents or locking the screen does not stop tracking
- Active tracking is restored after an ordinary OS process restart or device reboot
- Location, accuracy, speed, heading, and battery level are queued before upload
- The offline queue retains up to 10,000 fixes and refreshes expired login tokens
- Duty end stops the foreground service and releases its partial wake lock
- All API calls go to the same server URL

Android still allows a user to force-stop an app, disable device location, revoke
permissions, or power off the phone. No ordinary application can override those OS
and hardware controls. For company-owned devices, use Android Enterprise device-owner
(kiosk/MDM) policies in addition to the in-app tracking-health alerts.

## Updating the App

After making changes to the web app:
```bash
npx cap sync android
```
Then rebuild in Android Studio.

## Android Permissions (in AndroidManifest.xml)

The committed native manifest includes:
- `INTERNET`
- `ACCESS_FINE_LOCATION`
- `ACCESS_COARSE_LOCATION`
- `ACCESS_BACKGROUND_LOCATION`
- `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_LOCATION`
- `WAKE_LOCK`
- `POST_NOTIFICATIONS`
- `RECEIVE_BOOT_COMPLETED`
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
