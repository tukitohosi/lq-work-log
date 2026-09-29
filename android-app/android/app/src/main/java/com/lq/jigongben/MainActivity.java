package com.lq.jigongben;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LqPrintPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
