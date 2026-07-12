package com.farreo.app;

import android.os.CancellationSignal;

import androidx.core.content.ContextCompat;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

@CapacitorPlugin(name = "FarreoGoogleAuth")
public class FarreoGoogleAuthPlugin extends Plugin {
    @PluginMethod
    public void signIn(PluginCall call) {
        String webClientId = call.getString("webClientId", "").trim();
        if (webClientId.isEmpty()) {
            call.reject("Falta configurar el cliente OAuth web de Farreo.");
            return;
        }

        GetSignInWithGoogleOption googleOption = new GetSignInWithGoogleOption.Builder(webClientId).build();
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(googleOption)
            .build();

        CredentialManager manager = CredentialManager.create(getContext());
        manager.getCredentialAsync(
            getActivity(),
            request,
            new CancellationSignal(),
            ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    Credential credential = response.getCredential();
                    if (!(credential instanceof CustomCredential)
                        || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                        call.reject("Google no devolvio una credencial valida.");
                        return;
                    }

                    try {
                        GoogleIdTokenCredential googleCredential = GoogleIdTokenCredential.createFrom(
                            ((CustomCredential) credential).getData()
                        );
                        JSObject result = new JSObject();
                        result.put("idToken", googleCredential.getIdToken());
                        call.resolve(result);
                    } catch (Exception error) {
                        call.reject("No se pudo leer la credencial de Google.");
                    }
                }

                @Override
                public void onError(GetCredentialException error) {
                    call.reject(error.getMessage() == null ? "No se pudo iniciar sesion con Google." : error.getMessage());
                }
            }
        );
    }
}
