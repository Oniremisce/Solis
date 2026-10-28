package top.izuna.solis.tv;

import android.os.Bundle;
import android.webkit.WebSettings;

import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SafFolderPlugin.class);
        super.onCreate(savedInstanceState);
        // Android 15 以下强制 edge-to-edge，与 15+ 的系统强制行为对齐，
        // 让 Capacitor SystemBars 在所有系统版本上都走同一条 insets 直通链路。
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        // FM 推荐流为启动自动播放（无用户手势）：显式关闭媒体播放手势要求，
        // 防止部分 WebView 构建忽略 Capacitor 的默认设置导致自动播被静默拒绝。
        WebSettings settings = bridge.getWebView().getSettings();
        settings.setMediaPlaybackRequiresUserGesture(false);
    }
}
