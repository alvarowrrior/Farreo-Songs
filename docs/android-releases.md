# Publicar Farreo para Android

El workflow `Publicar APK de Farreo` crea una GitHub Release al subir una nueva version Android a `main`. La APK siempre queda disponible en esta URL:

`https://github.com/alvarowrrior/Farreo-Songs/releases/latest/download/Farreo.apk`

## Configuracion inicial

Android exige que todas las actualizaciones usen exactamente la misma firma. Crea una clave una sola vez y guardala tambien fuera de GitHub; si se pierde, no se podran actualizar las instalaciones existentes.

```powershell
keytool -genkeypair -v -keystore farreo-release.jks -alias farreo -keyalg RSA -keysize 4096 -validity 10000
[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path .\farreo-release.jks))) | Set-Clipboard
```

En `Settings > Secrets and variables > Actions` del repositorio crea:

- `ANDROID_KEYSTORE_BASE64`: el texto Base64 copiado por PowerShell.
- `ANDROID_KEYSTORE_PASSWORD`: la contrasena del keystore.
- `ANDROID_KEY_ALIAS`: `farreo`, salvo que eligieras otro alias.
- `ANDROID_KEY_PASSWORD`: la contrasena de la clave.

No subas `farreo-release.jks` al repositorio.

## Crear una version

1. Incrementa `versionCode` y `versionName` en `android/app/build.gradle`.
2. Sube el cambio a `main`.
3. GitHub compila la APK firmada, crea la release y actualiza el manifiesto usado por la app.

La primera APK firmada por este workflow puede requerir desinstalar una APK debug anterior. A partir de esa instalacion, las siguientes versiones se actualizan encima sin perder los datos de la app.
