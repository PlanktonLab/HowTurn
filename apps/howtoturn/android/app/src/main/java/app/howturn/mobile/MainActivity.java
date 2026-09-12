package app.howturn.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HowTurnNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
