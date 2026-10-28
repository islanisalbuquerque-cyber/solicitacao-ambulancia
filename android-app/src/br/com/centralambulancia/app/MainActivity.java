package br.com.centralambulancia.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.ClientCertRequest;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.HttpAuthHandler;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebBackForwardList;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebViewDatabase;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Collections;
import java.util.Locale;

/** Native HTTPS client. No JavaScript bridge, embedded account or remote default URL. */
public final class MainActivity extends Activity {
    private static final int YELLOW = Color.rgb(255, 230, 0);
    private static final int NAVY = Color.rgb(45, 50, 119);
    private static final int BLUE = Color.rgb(52, 131, 250);
    private static final int CANVAS = Color.rgb(243, 244, 247);
    private static final String ORIGIN_KEY = "origin";

    private SharedPreferences preferences;
    private volatile String origin = "";
    private String pendingOrigin;
    private String retryUrl;
    private String failureTitle;
    private String failureMessage;
    private boolean pageFailed;
    private Object backCallback;
    private LinearLayout root;
    private FrameLayout content;
    private WebView webView;
    private ProgressBar progress;
    private TextView toolbarOrigin;
    private ScrollView statePanel;
    private TextView stateTitle;
    private TextView stateMessage;
    private TextView stateOrigin;
    private Button retryButton;
    private Button configureButton;
    private AlertDialog originDialog;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences("connection", MODE_PRIVATE);
        try {
            String saved = preferences.getString(ORIGIN_KEY, "");
            if (!saved.isEmpty()) origin = normalizeOrigin(saved);
        } catch (IllegalArgumentException ex) {
            preferences.edit().remove(ORIGIN_KEY).apply();
        }
        buildInterface();
        if (Build.VERSION.SDK_INT >= 33) backCallback = BackApi33.register(this);

        if (savedInstanceState != null) {
            String pending = savedInstanceState.getString("pending_origin", "");
            if (!pending.isEmpty()) {
                try { changeOrigin(normalizeOrigin(pending)); return; }
                catch (IllegalArgumentException ignored) { /* Reopen the saved valid origin. */ }
            }
        }
        if (origin.isEmpty()) {
            showConfigurationState();
            root.post(() -> showOriginDialog());
            return;
        }
        updateOriginLabel();
        if (!createWebView()) return;
        if (savedInstanceState != null && origin.equals(savedInstanceState.getString("state_origin"))) {
            String savedRetry = savedInstanceState.getString("retry_url", origin + "/");
            retryUrl = isAllowedUrl(savedRetry) ? savedRetry : origin + "/";
            if (savedInstanceState.getBoolean("page_failed")) {
                showFailure(savedInstanceState.getString("failure_title", s("connection_error_title")),
                        savedInstanceState.getString("failure_message", s("connection_error_message")), retryUrl);
                return;
            }
            Bundle webState = savedInstanceState.getBundle("web_state");
            if (webState != null) {
                try {
                    WebBackForwardList history = webView.restoreState(webState);
                    boolean valid = history != null && history.getSize() > 0;
                    if (valid) {
                        for (int index = 0; index < history.getSize(); index++) {
                            if (!isAllowedUrl(history.getItemAtIndex(index).getUrl())) { valid = false; break; }
                        }
                    }
                    if (valid) {
                        statePanel.setVisibility(View.GONE);
                        webView.setVisibility(View.VISIBLE);
                        return;
                    }
                } catch (RuntimeException ignored) { /* Restore by loading the configured origin. */ }
                destroyWebView();
            }
        }
        loadPage(origin + "/");
    }

    /** Accept only an HTTPS origin; explicitly reject paths and embedded secrets. */
    static String normalizeOrigin(String input) {
        if (input == null || input.trim().isEmpty() || input.length() > 2048) throw new IllegalArgumentException();
        try {
            URI value = new URI(input.trim());
            String path = value.getRawPath();
            String host = value.getHost();
            int port = value.getPort();
            if (value.isOpaque() || !"https".equalsIgnoreCase(value.getScheme()) || host == null || host.isEmpty()
                    || value.getRawUserInfo() != null || value.getRawQuery() != null || value.getRawFragment() != null
                    || (path != null && !path.isEmpty() && !"/".equals(path))
                    || port == 0 || port < -1 || port > 65535) throw new IllegalArgumentException();
            return new URI("https", null, host.toLowerCase(Locale.ROOT), port == 443 ? -1 : port,
                    null, null, null).toASCIIString();
        } catch (URISyntaxException ex) {
            throw new IllegalArgumentException(ex);
        }
    }

    private boolean isAllowedUrl(String url) {
        String configured = origin;
        if (configured.isEmpty() || url == null) return false;
        try {
            URI value = new URI(url);
            URI server = new URI(configured);
            return "https".equalsIgnoreCase(value.getScheme()) && value.getHost() != null
                    && value.getRawUserInfo() == null && value.getHost().equalsIgnoreCase(server.getHost())
                    && httpsPort(value) == httpsPort(server);
        } catch (URISyntaxException ex) { return false; }
    }

    private static int httpsPort(URI uri) { return uri.getPort() == -1 ? 443 : uri.getPort(); }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private String s(String name) { return getString(getResources().getIdentifier(name, "string", getPackageName())); }

    private TextView text(String value, float size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private GradientDrawable background(int color, int border, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radius));
        if (border != 0) drawable.setStroke(dp(1), border);
        return drawable;
    }

    private Button button(String title, boolean primary) {
        Button button = new Button(this);
        button.setText(title);
        button.setTextSize(14);
        button.setAllCaps(false);
        button.setTextColor(primary ? Color.WHITE : NAVY);
        button.setMinHeight(dp(48));
        button.setMinimumHeight(dp(48));
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setPadding(dp(16), dp(8), dp(16), dp(8));
        button.setBackground(background(primary ? BLUE : Color.WHITE, primary ? 0 : Color.rgb(219, 224, 238), 10));
        return button;
    }

    private void buildInterface() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(YELLOW);
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(12), dp(9), dp(12), dp(9));
        header.setBackgroundColor(YELLOW);
        ImageView icon = new ImageView(this);
        icon.setImageDrawable(getApplicationInfo().loadIcon(getPackageManager()));
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams iconLayout = new LinearLayout.LayoutParams(dp(42), dp(42));
        iconLayout.setMarginEnd(dp(10));
        header.addView(icon, iconLayout);
        LinearLayout identity = new LinearLayout(this);
        identity.setOrientation(LinearLayout.VERTICAL);
        TextView title = text(s("app_name"), 15, NAVY, true);
        title.setMaxLines(2);
        identity.addView(title);
        toolbarOrigin = text("", 11, NAVY, false);
        toolbarOrigin.setSingleLine(true);
        toolbarOrigin.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        identity.addView(toolbarOrigin);
        header.addView(identity, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button settings = button(s("server"), false);
        settings.setContentDescription(s("settings_description"));
        settings.setBackground(background(Color.rgb(255, 243, 160), Color.rgb(227, 207, 85), 10));
        settings.setOnClickListener(view -> showSettings());
        LinearLayout.LayoutParams settingsLayout = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48));
        settingsLayout.setMarginStart(dp(8));
        header.addView(settings, settingsLayout);
        root.addView(header, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setVisibility(View.GONE);
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));
        content = new FrameLayout(this);
        content.setBackgroundColor(CANVAS);
        root.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        buildStatePanel();
        setContentView(root);
        applyInsets();
    }

    private void buildStatePanel() {
        statePanel = new ScrollView(this);
        statePanel.setFillViewport(true);
        statePanel.setBackgroundColor(CANVAS);
        LinearLayout holder = new LinearLayout(this);
        holder.setOrientation(LinearLayout.VERTICAL);
        holder.setGravity(Gravity.CENTER);
        holder.setPadding(dp(24), dp(32), dp(24), dp(32));
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(24), dp(26), dp(24), dp(26));
        card.setBackground(background(Color.WHITE, Color.rgb(227, 230, 239), 16));
        stateTitle = text("", 23, NAVY, true);
        if (Build.VERSION.SDK_INT >= 28) stateTitle.setAccessibilityHeading(true);
        card.addView(stateTitle);
        stateMessage = text("", 15, Color.rgb(102, 110, 136), false);
        stateMessage.setLineSpacing(dp(4), 1);
        LinearLayout.LayoutParams paragraph = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        paragraph.topMargin = dp(12);
        card.addView(stateMessage, paragraph);
        stateOrigin = text("", 12, NAVY, false);
        stateOrigin.setTextIsSelectable(true);
        stateOrigin.setPadding(0, dp(18), 0, dp(18));
        card.addView(stateOrigin);
        retryButton = button(s("retry"), true);
        retryButton.setOnClickListener(view -> loadPage(isAllowedUrl(retryUrl) ? retryUrl : origin + "/"));
        card.addView(retryButton, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        configureButton = button(s("configure_button"), false);
        configureButton.setOnClickListener(view -> showOriginDialog());
        LinearLayout.LayoutParams configureLayout = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        configureLayout.topMargin = dp(10);
        card.addView(configureButton, configureLayout);
        holder.addView(card, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        statePanel.addView(holder, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        content.addView(statePanel, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void applyInsets() {
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                return WindowInsets.CONSUMED;
            }
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        root.requestApplyInsets();
    }

    @SuppressWarnings("deprecation")
    private boolean createWebView() {
        if (webView != null) return true;
        try {
            WebView.setWebContentsDebuggingEnabled(false);
            WebView view = new WebView(this);
            view.setSaveEnabled(false);
            view.setSaveFromParentEnabled(false);
            view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
            view.setBackgroundColor(Color.WHITE);
            WebSettings settings = view.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setAllowFileAccessFromFileURLs(false);
            settings.setAllowUniversalAccessFromFileURLs(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setBuiltInZoomControls(false);
            settings.setDisplayZoomControls(false);
            settings.setSupportZoom(false);
            settings.setSupportMultipleWindows(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setSafeBrowsingEnabled(true);
            settings.setGeolocationEnabled(false);
            settings.setSaveFormData(false);
            settings.setSavePassword(false);
            settings.setMediaPlaybackRequiresUserGesture(true);
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
            view.setWebViewClient(new RestrictedClient());
            view.setWebChromeClient(new WebChromeClient() {
                @Override public void onProgressChanged(WebView current, int value) {
                    if (current != webView || pageFailed) return;
                    progress.setProgress(value);
                    progress.setVisibility(value >= 100 ? View.GONE : View.VISIBLE);
                }
                @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
                @Override public void onGeolocationPermissionsShowPrompt(String requestedOrigin, GeolocationPermissions.Callback callback) {
                    callback.invoke(requestedOrigin, false, false);
                }
                @Override public boolean onCreateWindow(WebView current, boolean dialog, boolean userGesture, android.os.Message resultMsg) {
                    toast(s("blocked_navigation"));
                    return false;
                }
                @Override public boolean onShowFileChooser(WebView current, ValueCallback<Uri[]> callback, FileChooserParams params) {
                    callback.onReceiveValue(null);
                    return true;
                }
            });
            view.setDownloadListener((url, userAgent, disposition, mimeType, length) -> toast(s("downloads_unavailable")));
            webView = view;
            content.addView(view, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            return true;
        } catch (RuntimeException ex) {
            destroyWebView();
            showFailure(s("webview_error_title"), s("webview_error_message"), origin + "/");
            return false;
        }
    }

    private final class RestrictedClient extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (isAllowedUrl(url)) return false;
            if (request.isForMainFrame() && request.hasGesture() && "mailto".equalsIgnoreCase(request.getUrl().getScheme())) {
                try { startActivity(new Intent(Intent.ACTION_SENDTO, request.getUrl())); }
                catch (ActivityNotFoundException | SecurityException ex) { toast(s("no_email_app")); }
            } else if (request.isForMainFrame()) toast(s("blocked_navigation"));
            return true;
        }
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (isAllowedUrl(request.getUrl().toString())) return null;
            return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(),
                    new ByteArrayInputStream(new byte[0]));
        }
        @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (view != webView) return;
            if (!isAllowedUrl(url)) {
                view.stopLoading();
                showFailure(s("blocked_title"), s("blocked_message"), origin + "/");
                return;
            }
            retryUrl = url;
            pageFailed = false;
            statePanel.setVisibility(View.GONE);
            view.setVisibility(View.VISIBLE);
            progress.setVisibility(View.VISIBLE);
        }
        @Override public void onPageFinished(WebView view, String url) {
            if (view != webView) return;
            progress.setVisibility(View.GONE);
            CookieManager.getInstance().flush();
        }
        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (view == webView && request.isForMainFrame()) {
                showFailure(s("connection_error_title"), s("connection_error_message"), request.getUrl().toString());
            }
        }
        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (view == webView && request.isForMainFrame()) {
                showFailure(s("connection_error_title"), s("http_error_message"), request.getUrl().toString());
            }
        }
        @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            if (view == webView) {
                view.stopLoading();
                showFailure(s("ssl_error_title"), s("ssl_error_message"), origin + "/");
            }
        }
        @Override public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) { handler.cancel(); }
        @Override public void onReceivedClientCertRequest(WebView view, ClientCertRequest request) { request.cancel(); }
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (view == webView) {
                destroyWebView();
                showFailure(s("renderer_error_title"), s("renderer_error_message"), origin + "/");
            }
            return true;
        }
    }

    private void loadPage(String url) {
        if (pendingOrigin != null) return;
        if (origin.isEmpty()) { showConfigurationState(); return; }
        if (!createWebView()) return;
        retryUrl = isAllowedUrl(url) ? url : origin + "/";
        pageFailed = false;
        statePanel.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        progress.setVisibility(View.VISIBLE);
        webView.loadUrl(retryUrl);
    }

    private void updateOriginLabel() {
        String displayed = pendingOrigin != null ? pendingOrigin : origin;
        if (displayed.isEmpty()) displayed = s("server_unconfigured");
        toolbarOrigin.setText(displayed);
        toolbarOrigin.setContentDescription(s("server") + ": " + displayed);
        stateOrigin.setText(displayed);
    }

    private void showConfigurationState() {
        pageFailed = false;
        stateTitle.setText(s("configure_title"));
        stateMessage.setText(s("configure_message"));
        retryButton.setVisibility(View.GONE);
        configureButton.setEnabled(true);
        statePanel.setVisibility(View.VISIBLE);
        progress.setVisibility(View.GONE);
        updateOriginLabel();
    }

    private void showFailure(String title, String message, String failedUrl) {
        pageFailed = true;
        failureTitle = title;
        failureMessage = message;
        retryUrl = isAllowedUrl(failedUrl) ? failedUrl : origin + "/";
        stateTitle.setText(title);
        stateMessage.setText(message);
        retryButton.setVisibility(origin.isEmpty() ? View.GONE : View.VISIBLE);
        retryButton.setEnabled(pendingOrigin == null);
        configureButton.setEnabled(pendingOrigin == null);
        progress.setVisibility(View.GONE);
        if (webView != null) webView.setVisibility(View.GONE);
        statePanel.setVisibility(View.VISIBLE);
        updateOriginLabel();
        stateTitle.announceForAccessibility(title);
    }

    private void showSettings() {
        if (pendingOrigin != null) return;
        new AlertDialog.Builder(this).setTitle(s("server"))
                .setItems(new String[]{s("change_server"), s("about")}, (dialog, which) -> {
                    if (which == 0) showOriginDialog(); else showAbout();
                }).setNegativeButton(s("cancel"), null).show();
    }

    private void showOriginDialog() {
        if (isFinishing() || isDestroyed() || pendingOrigin != null || (originDialog != null && originDialog.isShowing())) return;
        LinearLayout fields = new LinearLayout(this);
        fields.setOrientation(LinearLayout.VERTICAL);
        fields.setPadding(dp(24), dp(12), dp(24), 0);
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        input.setHint(s("server_dialog_hint"));
        input.setContentDescription(s("server_dialog_hint"));
        input.setText(origin);
        input.setSelectAllOnFocus(true);
        input.setSaveEnabled(false);
        fields.addView(input, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView help = text(s("server_dialog_help"), 13, Color.rgb(102, 110, 136), false);
        help.setPadding(0, dp(12), 0, dp(8));
        fields.addView(help);
        originDialog = new AlertDialog.Builder(this).setTitle(s("server_dialog_title")).setView(fields)
                .setPositiveButton(s("connect"), null).setNegativeButton(s("cancel"), null).create();
        originDialog.setOnShowListener(dialog -> {
            originDialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                final String candidate;
                try { candidate = normalizeOrigin(input.getText().toString()); }
                catch (IllegalArgumentException ex) { input.setError(s("server_invalid")); input.requestFocus(); return; }
                if (candidate.equals(origin)) { originDialog.dismiss(); return; }
                if (!origin.isEmpty()) {
                    new AlertDialog.Builder(this).setTitle(s("change_title")).setMessage(s("change_message"))
                            .setNegativeButton(s("cancel"), null).setPositiveButton(s("change_confirm"), (confirm, which) -> {
                                originDialog.dismiss();
                                changeOrigin(candidate);
                            }).show();
                } else { originDialog.dismiss(); changeOrigin(candidate); }
            });
            input.setOnEditorActionListener((field, action, event) -> {
                if (action == EditorInfo.IME_ACTION_GO) { originDialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick(); return true; }
                return false;
            });
            input.requestFocus();
            originDialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        });
        originDialog.show();
    }

    @SuppressWarnings("deprecation")
    private void changeOrigin(final String candidate) {
        pendingOrigin = candidate;
        if (webView != null) { webView.stopLoading(); webView.clearCache(true); webView.clearHistory(); }
        destroyWebView();
        showFailure(s("preparing_title"), s("preparing_message"), candidate + "/");
        try {
            WebStorage.getInstance().deleteAllData();
            WebViewDatabase.getInstance(this).clearHttpAuthUsernamePassword();
            WebViewDatabase.getInstance(this).clearFormData();
            CookieManager.getInstance().removeAllCookies(removed -> {
                CookieManager.getInstance().flush();
                if (isFinishing() || isDestroyed()) return;
                // Commit the new configuration only after the old session cookies are removed.
                origin = candidate;
                preferences.edit().putString(ORIGIN_KEY, candidate).apply();
                pendingOrigin = null;
                retryButton.setEnabled(true);
                configureButton.setEnabled(true);
                updateOriginLabel();
                loadPage(candidate + "/");
            });
        } catch (RuntimeException ex) {
            pendingOrigin = null;
            showFailure(s("webview_error_title"), s("webview_error_message"), origin + "/");
        }
    }

    private void showAbout() {
        String version = "1.0.0";
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            version = info.versionName + " (" + (Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode) + ")";
        } catch (android.content.pm.PackageManager.NameNotFoundException ignored) { }
        new AlertDialog.Builder(this).setTitle(s("about"))
                .setMessage(s("version") + " " + version + "\n\n" + s("about_message"))
                .setPositiveButton(s("close"), null).show();
    }

    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_SHORT).show(); }
    private void handleBack() {
        if (pendingOrigin != null) return;
        if (webView != null && statePanel.getVisibility() != View.VISIBLE && webView.canGoBack()) { webView.goBack(); return; }
        new AlertDialog.Builder(this).setTitle(s("exit_title")).setMessage(s("exit_message"))
                .setNegativeButton(s("cancel"), null).setPositiveButton(s("exit_confirm"), (dialog, which) -> finish()).show();
    }
    @Override public void onBackPressed() { handleBack(); }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("state_origin", origin);
        if (pendingOrigin != null) state.putString("pending_origin", pendingOrigin);
        state.putString("retry_url", retryUrl);
        state.putBoolean("page_failed", pageFailed);
        state.putString("failure_title", failureTitle);
        state.putString("failure_message", failureMessage);
        if (webView != null && !pageFailed && pendingOrigin == null) {
            Bundle webState = new Bundle();
            if (webView.saveState(webState) != null) state.putBundle("web_state", webState);
        }
        super.onSaveInstanceState(state);
    }
    @Override protected void onPause() {
        if (webView != null) webView.onPause();
        try { CookieManager.getInstance().flush(); }
        catch (RuntimeException ignored) { /* The native configuration screen still works without a WebView provider. */ }
        super.onPause();
    }
    @Override protected void onResume() { super.onResume(); if (webView != null) webView.onResume(); }
    private void destroyWebView() {
        if (webView == null) return;
        WebView current = webView;
        webView = null;
        if (current.getParent() instanceof ViewGroup) ((ViewGroup) current.getParent()).removeView(current);
        current.destroy();
    }
    @Override protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) BackApi33.unregister(this, backCallback);
        if (originDialog != null) originDialog.dismiss();
        destroyWebView();
        super.onDestroy();
    }

    /** Keep Android 13 class resolution outside the Android 8 execution path. */
    private static final class BackApi33 {
        static Object register(MainActivity activity) {
            android.window.OnBackInvokedCallback callback = activity::handleBack;
            activity.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
            return callback;
        }
        static void unregister(MainActivity activity, Object callback) {
            activity.getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback((android.window.OnBackInvokedCallback) callback);
        }
    }
}
