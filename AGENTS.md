# Farreo: guia para agentes

Este archivo contiene contexto operativo que cualquier IA debe leer antes de modificar o publicar Farreo.

## Arquitectura movil

- La aplicacion Android usa Capacitor con `appId` `com.farreo.app`.
- La APK carga la interfaz remota `https://farreo.vercel.app/mobile` dentro de un WebView.
- `capacitor.config.ts` permite sustituir esa URL con `CAPACITOR_SERVER_URL` o `FARREO_ANDROID_URL` para desarrollo.
- El audio en la APK usa el bridge nativo `FarreoNativeAudio` y AndroidX Media3. Los cambios en Java, Gradle, AndroidManifest, recursos Android o el bridge requieren una APK nueva.
- Los cambios que afectan solamente a Next.js, React, estilos o `/mobile` normalmente solo requieren desplegar la web en Vercel. No reconstruyas la APK por un cambio puramente web.

## Release de Android

El workflow oficial es `.github/workflows/publish-android.yml`. Se ejecuta:

- al subir a `main` cambios dentro de `android/**` o del propio workflow;
- manualmente mediante `workflow_dispatch`.

El workflow compila una APK release firmada, crea o actualiza una GitHub Release y publica siempre el archivo con el nombre exacto `Farreo.apk`.

URL estable de descarga:

`https://github.com/alvarowrrior/Farreo-Songs/releases/latest/download/Farreo.apk`

No cambies el nombre `Farreo.apk` ni esta URL sin actualizar tambien el sistema de actualizaciones de la aplicacion.

### Crear una version nueva

1. Incrementa `versionCode` y `versionName` en `android/app/build.gradle`. `versionCode` debe ser siempre mayor que el de cualquier APK publicada.
2. Comprueba que `public/mobile-app-version.json` conserva la URL estable. El workflow sincroniza su version y build despues de publicar.
3. Ejecuta las verificaciones pertinentes.
4. Solo haz commit o push a `main` si el usuario lo pide expresamente.
5. Tras el push, comprueba que la Action termina correctamente, que la release es la mas reciente y que su asset se llama `Farreo.apk`.
6. Comprueba que Vercel ha desplegado el manifiesto actualizado para que la app pueda avisar de la nueva version.

`public/mobile-app-version.json` controla el aviso de actualizacion dentro de la app. Su `downloadUrl` debe seguir apuntando a la URL estable de GitHub Releases.

## Firma: no romper las actualizaciones

Android solo permite instalar una actualizacion sobre otra si ambas APK usan la misma clave. No regeneres, reemplaces ni elimines la clave de release salvo peticion explicita del propietario.

Los siguientes GitHub Actions Secrets ya estan configurados en `alvarowrrior/Farreo-Songs`:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Nunca muestres sus valores, los escribas en logs ni los guardes en el repositorio.

La copia local permanente de firma de esta maquina esta fuera del repositorio:

- Keystore: `C:\Users\Wachii\.farreo\signing\farreo-release.jks`
- Datos protegidos: `C:\Users\Wachii\.farreo\signing\release-signing.json`

No leas ni imprimas las contrasenas del segundo archivo salvo que el usuario solicite expresamente una operacion de firma local. Nunca anadas ninguno de esos archivos a Git.

Certificado esperado, SHA-256:

`83db7c616cffb984c7a6e4535f526432ea5dcb2d2c892edb7eb27fc8c440964b`

Una instalacion antigua firmada como debug puede exigir desinstalarla una sola vez antes de instalar la primera APK release. Tras instalar una APK con la firma permanente, las versiones posteriores deben actualizarse encima sin borrar datos.

## Verificaciones recomendadas

Para cambios web o compartidos:

```powershell
npm run lint
npx tsc --noEmit
npm run build
```

Para sincronizar y comprobar Android en Windows:

```powershell
npm run android:sync
npm run android:build:debug
```

La Action de GitHub es el camino normal para generar la APK release firmada. Si se hace una firma local, verifica el certificado final y no expongas credenciales en comandos, logs o respuestas.

## Enlaces y actualizaciones

- La APK debe seguir abriendo los enlaces compatibles de `farreo.vercel.app` y resolverlos dentro de `/mobile`.
- El repositorio y sus GitHub Releases son publicos. La URL de la APK no es un mecanismo de acceso privado; cualquiera con el enlace puede descargarla.
- El aviso de nueva version compara la version/build nativos con `public/mobile-app-version.json` y debe aparecer al abrir una APK desactualizada.

## Servicios externos

- Los cambios dentro de `backend/` deben copiarse al servidor externo y requieren reiniciar el servicio de musica. Avisa siempre al usuario cuando se modifique esa carpeta.
- Los cambios dentro de `backend_bot_discord/` tambien deben copiarse y reiniciarse en su servidor. Avisa siempre al usuario.
- No supongas que modificar una copia local de esos backends actualiza automaticamente produccion.

## Git y seguridad

- Puede haber cambios locales del usuario. No los reviertas ni limpies el worktree sin permiso.
- No hagas push, publiques una release ni rotes Secrets por iniciativa propia.
- No incluyas keystores, contrasenas, tokens, archivos `.env` ni credenciales en commits.
- La documentacion detallada del flujo Android esta en `docs/android-releases.md`.
