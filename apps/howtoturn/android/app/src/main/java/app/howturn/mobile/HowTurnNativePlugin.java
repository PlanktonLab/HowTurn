package app.howturn.mobile;

import android.speech.tts.TextToSpeech;
import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Foreground navigation support missing from Android's Web Speech API. */
@CapacitorPlugin(name = "HowTurnNative")
public class HowTurnNativePlugin extends Plugin {
    private TextToSpeech speech;
    private boolean ready;
    private boolean unavailable;
    private final List<PluginCall> pending = new ArrayList<>();

    @Override
    public void load() {
        getActivity().runOnUiThread(() -> {
            speech = new TextToSpeech(getContext(), status -> getActivity().runOnUiThread(() -> {
                if (status == TextToSpeech.SUCCESS) {
                    int language = speech.setLanguage(Locale.TAIWAN);
                    ready = language != TextToSpeech.LANG_MISSING_DATA && language != TextToSpeech.LANG_NOT_SUPPORTED;
                    speech.setSpeechRate(1.05f);
                }
                unavailable = !ready;
                for (PluginCall call : new ArrayList<>(pending)) speakReady(call);
                pending.clear();
            }));
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (Boolean.TRUE.equals(call.getBoolean("interrupt", false))) clearPending();
            if (!ready && !unavailable) pending.add(call);
            else speakReady(call);
        });
    }

    private void speakReady(PluginCall call) {
        if (!ready || speech == null) {
            call.reject("請在 Android 的文字轉語音設定安裝繁體中文語音");
            return;
        }
        String text = call.getString("text", "");
        int queue = Boolean.TRUE.equals(call.getBoolean("interrupt", false)) ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
        int result = speech.speak(text, queue, null, "howturn-" + System.nanoTime());
        if (result == TextToSpeech.ERROR) call.reject("無法播放導航語音");
        else call.resolve();
    }

    private void clearPending() {
        for (PluginCall call : pending) call.resolve();
        pending.clear();
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            clearPending();
            if (speech != null) speech.stop();
            call.resolve();
        });
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (Boolean.TRUE.equals(call.getBoolean("enabled", false))) {
                getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        clearPending();
        if (speech != null) {
            speech.stop();
            speech.shutdown();
            speech = null;
        }
        ready = false;
    }
}
