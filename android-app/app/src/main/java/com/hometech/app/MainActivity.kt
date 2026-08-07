package com.hometech.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import android.view.View
import android.webkit.*
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    companion object {
        // ─── CHANGE THIS TO YOUR DEPLOYED URL ──────────────────────────────────
        const val APP_URL = "https://www.orderpluserp.in"
        // ───────────────────────────────────────────────────────────────────────
    }

    private lateinit var webView: WebView
    private lateinit var rootLayout: View
    private lateinit var swipeRefresh: androidx.swiperefreshlayout.widget.SwipeRefreshLayout
    private lateinit var progressBar: ProgressBar
    private lateinit var offlineLayout: FrameLayout
    private lateinit var offlineMessageView: TextView

    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var cameraImageUri: Uri? = null

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        // After foreground location is granted, request background location
        // on Android 10+ (must be a separate prompt — system requirement).
        val fineGranted =
            results[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED
        if (fineGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val bgGranted = ContextCompat.checkSelfPermission(
                this, Manifest.permission.ACCESS_BACKGROUND_LOCATION
            ) == PackageManager.PERMISSION_GRANTED
            if (!bgGranted) {
                backgroundLocationLauncher.launch(
                    arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                )
            }
        }
    }

    private val backgroundLocationLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { /* user choice surfaces in Settings — foreground service still tracks regardless */ }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uris: Array<Uri>? = when {
            result.resultCode != Activity.RESULT_OK -> null
            result.data?.data != null -> arrayOf(result.data!!.data!!)
            cameraImageUri != null -> arrayOf(cameraImageUri!!)
            else -> null
        }
        fileUploadCallback?.onReceiveValue(uris)
        fileUploadCallback = null
        cameraImageUri = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        rootLayout         = findViewById(R.id.rootLayout)
        webView            = findViewById(R.id.webView)
        swipeRefresh       = findViewById(R.id.swipeRefresh)
        progressBar        = findViewById(R.id.progressBar)
        offlineLayout      = findViewById(R.id.offlineLayout)
        offlineMessageView = findViewById(R.id.offlineMessage)

        setupSystemBarInsets()
        setupWebView()
        setupSwipeRefresh()
        requestRequiredPermissions()
        requestBatteryOptimizationExemption()

        if (isNetworkAvailable()) {
            val url = intent?.data?.toString()?.takeIf { it.startsWith("orderplus://") }
                ?.replace("orderplus://open", APP_URL) ?: APP_URL
            webView.loadUrl(url)
        } else {
            showOffline()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled      = true
            domStorageEnabled      = true
            databaseEnabled        = true
            loadWithOverviewMode   = false
            useWideViewPort        = true
            builtInZoomControls    = false
            displayZoomControls    = false
            setSupportZoom(false)
            layoutAlgorithm        = WebSettings.LayoutAlgorithm.NORMAL
            textZoom               = 100
            allowFileAccess        = true
            allowContentAccess     = true
            mixedContentMode       = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode              = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            setGeolocationEnabled(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = true
        }
        webView.isHorizontalScrollBarEnabled = false
        webView.scrollBarStyle = View.SCROLLBARS_INSIDE_OVERLAY
        webView.overScrollMode = View.OVER_SCROLL_NEVER

        // ── Native JS bridge — exposes window.AndroidTracking to the page ─────
        webView.addJavascriptInterface(TrackingJsBridge(this), "AndroidTracking")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                progressBar.visibility = View.VISIBLE
                offlineLayout.visibility = View.GONE
                syncNativeAuthToWeb(view)
            }

            override fun onPageFinished(view: WebView, url: String) {
                progressBar.visibility   = View.GONE
                swipeRefresh.isRefreshing = false
                injectMobileCompatibility(view)
                syncNativeAuthToWeb(view)
                persistWebAuthAndContinue(view)

                // Inject a Capacitor shim so the salesman page finds
                // window.Capacitor.Plugins.BackgroundLocation and routes calls
                // to our native AndroidTracking bridge.
                view.evaluateJavascript("""
                    (function() {
                      if (!window.AndroidTracking) return;
                      window.Capacitor = {
                        isNativePlatform: function() { return true; },
                        getPlatform:      function() { return 'android'; },
                        Plugins: {
                          BackgroundLocation: {
                            startTracking: function(opts) {
                              return new Promise(function(resolve, reject) {
                                try {
                                  window.AndroidTracking.startTracking(JSON.stringify(opts));
                                  resolve();
                                } catch(e) { reject(e); }
                              });
                            },
                            stopTracking: function() {
                              return new Promise(function(resolve) {
                                try { window.AndroidTracking.stopTracking(); } catch(e) {}
                                resolve();
                              });
                            },
                            isTracking: function() {
                              return new Promise(function(resolve) {
                                try {
                                  resolve({ active: !!window.AndroidTracking.isTracking() });
                                } catch(e) { resolve({ active: false }); }
                              });
                            },
                            getGpsStatus: function() {
                              return new Promise(function(resolve) {
                                try {
                                  var raw = window.AndroidTracking.getGpsStatus();
                                  resolve(JSON.parse(raw));
                                } catch(e) {
                                  resolve({
                                    locationServicesEnabled: false,
                                    fineLocationGranted: false,
                                    backgroundLocationGranted: false,
                                    notificationsGranted: false,
                                    batteryOptimizationDisabled: false,
                                    trackingActive: false
                                  });
                                }
                              });
                            },
                            openLocationSettings: function() {
                              return new Promise(function(resolve) {
                                try {
                                  var opened = !!window.AndroidTracking.openLocationSettings();
                                  resolve({ opened: opened });
                                } catch(e) { resolve({ opened: false }); }
                              });
                            },
                            openNotificationSettings: function() {
                              return new Promise(function(resolve) {
                                try {
                                  var opened = !!window.AndroidTracking.openNotificationSettings();
                                  resolve({ opened: opened });
                                } catch(e) { resolve({ opened: false }); }
                              });
                            },
                            openBackgroundSettings: function() {
                              return new Promise(function(resolve) {
                                try {
                                  var opened = !!window.AndroidTracking.openBackgroundSettings();
                                  resolve({ opened: opened });
                                } catch(e) { resolve({ opened: false }); }
                              });
                            },
                            showGpsOffWarning: function() {
                              return new Promise(function(resolve) {
                                try { window.AndroidTracking.showGpsOffWarning(); } catch(e) {}
                                resolve();
                              });
                            },
                            requestBackgroundPermission: function() {
                              return new Promise(function(resolve) {
                                try { window.AndroidTracking.requestBackgroundPermission(); } catch(e) {}
                                resolve({ granted: true });
                              });
                            },
                            requestReliabilityPermissions: function() {
                              try {
                                window.AndroidTracking.openBackgroundSettings();
                                return Promise.resolve(JSON.parse(window.AndroidTracking.getReliabilityStatus()));
                              } catch(e) {
                                return Promise.resolve({
                                  batteryOptimizationDisabled: false,
                                  backgroundLocationGranted: false,
                                  notificationsGranted: false
                                });
                              }
                            }
                          }
                        }
                      };
                    })();
                """.trimIndent(), null)
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    progressBar.visibility    = View.GONE
                    swipeRefresh.isRefreshing = false
                    if (!isNetworkAvailable()) showOffline()
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url     = request.url.toString()
                val appHost = Uri.parse(APP_URL).host ?: return false
                return if (Uri.parse(url).host == appHost || url.startsWith(APP_URL)) {
                    false
                } else {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    true
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progressBar.progress = newProgress
                if (newProgress == 100) progressBar.visibility = View.GONE
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String, callback: GeolocationPermissions.Callback
            ) {
                if (ContextCompat.checkSelfPermission(
                        this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION
                    ) == PackageManager.PERMISSION_GRANTED
                ) {
                    callback.invoke(origin, true, false)
                } else {
                    permissionLauncher.launch(
                        arrayOf(
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                        )
                    )
                }
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                fileUploadCallback?.onReceiveValue(null)
                fileUploadCallback = filePathCallback

                val intents = mutableListOf<Intent>()

                val photoFile = createImageFile()
                if (photoFile != null) {
                    cameraImageUri = androidx.core.content.FileProvider.getUriForFile(
                        this@MainActivity, "${packageName}.fileprovider", photoFile
                    )
                    intents.add(Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                        putExtra(MediaStore.EXTRA_OUTPUT, cameraImageUri)
                    })
                }

                val galleryIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "image/*"
                    addCategory(Intent.CATEGORY_OPENABLE)
                }
                fileChooserLauncher.launch(
                    Intent.createChooser(galleryIntent, "Select Image").apply {
                        putExtra(Intent.EXTRA_INITIAL_INTENTS, intents.toTypedArray())
                    }
                )
                return true
            }
        }

        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
    }

    /** Restore the durable login and keep it aligned when tracking rotated JWTs. */
    private fun syncNativeAuthToWeb(view: WebView = webView) {
        val authPrefs = getSharedPreferences(TrackingJsBridge.AUTH_PREFS_NAME, MODE_PRIVATE)
        val session = try {
            org.json.JSONObject(
                authPrefs.getString(TrackingJsBridge.KEY_AUTH_SESSION, "{}") ?: "{}"
            )
        } catch (_: Exception) {
            org.json.JSONObject()
        }

        // The foreground service can refresh tokens while the WebView is closed.
        val trackingPrefs = getSharedPreferences(LocationTrackingService.PREFS_NAME, MODE_PRIVATE)
        val trackedAccess = trackingPrefs.getString(LocationTrackingService.KEY_TOKEN, "") ?: ""
        val trackedRefresh = trackingPrefs.getString(LocationTrackingService.KEY_REFRESH_TOKEN, "") ?: ""
        if (trackedAccess.isNotEmpty() && trackedRefresh.isNotEmpty()) {
            session.put("accessToken", trackedAccess)
            session.put("refreshToken", trackedRefresh)
            if (session.has("user")) {
                authPrefs.edit().putString(
                    TrackingJsBridge.KEY_AUTH_SESSION, session.toString()
                ).apply()
            }
        }
        if (session.optString("accessToken").isEmpty() || !session.has("user")) return
        val sessionJson = org.json.JSONObject.quote(session.toString())
        view.evaluateJavascript("""
            (function() {
              try {
                var session = JSON.parse($sessionJson);
                localStorage.setItem('accessToken', session.accessToken);
                localStorage.setItem('refreshToken', session.refreshToken);
                localStorage.setItem('user', JSON.stringify(session.user));
                if (session.activeCompanyId) localStorage.setItem('activeCompanyId', session.activeCompanyId);
                if (session.activeCompanyName) localStorage.setItem('activeCompanyName', session.activeCompanyName);
                window.dispatchEvent(new Event('hometech:native-auth-restored'));
              } catch(e) {}
            })();
        """.trimIndent(), null)
    }

    /**
     * Capture an existing WebView login even when the deployed site predates the
     * native session bridge, and never leave a signed-in user on the login route.
     */
    private fun persistWebAuthAndContinue(view: WebView = webView) {
        view.evaluateJavascript("""
            (function() {
              try {
                var accessToken = localStorage.getItem('accessToken');
                var refreshToken = localStorage.getItem('refreshToken');
                var userRaw = localStorage.getItem('user');
                if (!accessToken || !refreshToken || !userRaw || !window.AndroidTracking) return;
                window.AndroidTracking.saveAuthSession(JSON.stringify({
                  accessToken: accessToken,
                  refreshToken: refreshToken,
                  user: JSON.parse(userRaw),
                  activeCompanyId: localStorage.getItem('activeCompanyId'),
                  activeCompanyName: localStorage.getItem('activeCompanyName')
                }));
                var path = window.location.pathname.replace(/\/+$/, '') || '/';
                if (path === '/' || path === '/login') window.location.replace('/dashboard');
              } catch(e) {}
            })();
        """.trimIndent(), null)
    }

    private fun setupSystemBarInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
    }

    private fun injectMobileCompatibility(view: WebView) {
        view.evaluateJavascript("""
            (function() {
              var viewport = document.querySelector('meta[name="viewport"]');
              if (!viewport) {
                viewport = document.createElement('meta');
                viewport.name = 'viewport';
                document.head.appendChild(viewport);
              }
              viewport.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
              document.documentElement.classList.add('android-webview');

              if (!document.getElementById('android-webview-compat-style')) {
                var style = document.createElement('style');
                style.id = 'android-webview-compat-style';
                style.textContent = [
                  'html.android-webview, html.android-webview body { width:100%; max-width:100%; overflow-x:hidden; -webkit-text-size-adjust:100%; text-size-adjust:100%; }',
                  'html.android-webview * { box-sizing:border-box; }',
                  'html.android-webview img, html.android-webview video, html.android-webview canvas { max-width:100%; height:auto; }',
                  '@media (max-width: 768px) { html.android-webview input, html.android-webview select, html.android-webview textarea { font-size:16px !important; } }'
                ].join('\n');
                document.head.appendChild(style);
              }
            })();
        """.trimIndent(), null)
    }

    private fun setupSwipeRefresh() {
        swipeRefresh.setColorSchemeResources(R.color.brand_primary)
        swipeRefresh.setOnRefreshListener {
            if (isNetworkAvailable()) {
                offlineLayout.visibility = View.GONE
                webView.reload()
            } else {
                swipeRefresh.isRefreshing = false
                showOffline()
            }
        }
    }

    private fun requestRequiredPermissions() {
        // Step 1: foreground permissions. Background location is requested
        // separately AFTER fine-location is granted (Android 10+ rule).
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions += Manifest.permission.POST_NOTIFICATIONS
        }

        val notGranted = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (notGranted.isNotEmpty()) {
            permissionLauncher.launch(notGranted.toTypedArray())
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            // Foreground already granted on a prior run — go straight to background prompt.
            backgroundLocationLauncher.launch(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION))
        }
    }

    /**
     * Ask the OS to exempt us from battery optimization. This is the single most
     * important fix for "tracking stops when the app is closed" — without it,
     * OEM battery managers and Doze kill the foreground service after a few
     * minutes in the background. Shown once; never again after the user allows it.
     */
    @SuppressLint("BatteryLife")
    private fun requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val pm = getSystemService(POWER_SERVICE) as? PowerManager ?: return
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        try {
            startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName")
                )
            )
        } catch (e: Exception) {
            // Fall back to the battery-optimization list if the direct prompt is blocked.
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: Exception) {}
        }
    }

    private fun isNetworkAvailable(): Boolean {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun showOffline() {
        offlineLayout.visibility = View.VISIBLE
        webView.visibility       = View.GONE
        progressBar.visibility   = View.GONE
    }

    private fun hideOffline() {
        offlineLayout.visibility = View.GONE
        webView.visibility       = View.VISIBLE
    }

    private fun createImageFile(): File? = try {
        val ts  = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
        val dir = getExternalFilesDir(Environment.DIRECTORY_PICTURES)
        File.createTempFile("IMG_${ts}_", ".jpg", dir)
    } catch (e: Exception) { null }

    @Deprecated("Use onBackPressedDispatcher")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        syncNativeAuthToWeb()
        if (isNetworkAvailable() && offlineLayout.visibility == View.VISIBLE) {
            hideOffline(); webView.reload()
        }
    }

    override fun onPause()   { super.onPause();   webView.onPause() }
    override fun onDestroy() { webView.destroy();  super.onDestroy() }
}
