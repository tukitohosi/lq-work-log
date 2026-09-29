package com.lq.jigongben;

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "LqPrint")
public class LqPrintPlugin extends Plugin {
    @PluginMethod
    public void print(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                String jobName = call.getString("jobName", "L.Q记工本");
                Boolean landscapeValue = call.getBoolean("landscape", false);
                boolean landscape = Boolean.TRUE.equals(landscapeValue);
                WebView webView = getBridge().getWebView();
                PrintDocumentAdapter delegate = webView.createPrintDocumentAdapter(jobName);
                PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
                    @Override
                    public void onStart() {
                        delegate.onStart();
                    }

                    @Override
                    public void onLayout(
                        PrintAttributes oldAttributes,
                        PrintAttributes newAttributes,
                        CancellationSignal cancellationSignal,
                        LayoutResultCallback callback,
                        Bundle extras
                    ) {
                        delegate.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras);
                    }

                    @Override
                    public void onWrite(
                        PageRange[] pages,
                        ParcelFileDescriptor destination,
                        CancellationSignal cancellationSignal,
                        WriteResultCallback callback
                    ) {
                        delegate.onWrite(pages, destination, cancellationSignal, callback);
                    }

                    @Override
                    public void onFinish() {
                        delegate.onFinish();
                        call.resolve();
                    }
                };
                PrintAttributes.MediaSize mediaSize = landscape
                    ? PrintAttributes.MediaSize.ISO_A4.asLandscape()
                    : PrintAttributes.MediaSize.ISO_A4.asPortrait();
                PrintAttributes attributes = new PrintAttributes.Builder()
                    .setMediaSize(mediaSize)
                    .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                    .build();
                PrintManager manager = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
                manager.print(jobName, adapter, attributes);
            } catch (Exception error) {
                call.reject("无法打开 Android 系统打印服务", error);
            }
        });
    }
}
