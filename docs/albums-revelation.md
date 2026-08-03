# Albumes y modo Revelacion

Los albumes se guardan en Firestore, pero ningun cliente web o Android accede a sus colecciones directamente. Todas las lecturas publicas, el progreso individual, los seguimientos y las mutaciones administrativas pasan por el backend Express usando Firebase Admin.

## Administradores y secreto de visitantes

Los albumes usan directamente la lista general `NEXT_PUBLIC_ADMIN_EMAILS` desplegada en Farreo. Express la obtiene de `https://farreo.vercel.app/api/admins`, la cachea durante cinco minutos y verifica el Firebase ID Token antes de aceptar cada mutacion. No hay que configurar otra lista en el servidor ni existe un tipo de administrador separado para albumes.

El backend genera por si mismo un secreto criptografico para las sesiones anonimas y lo conserva en `almacenamiento_compartido/albums/visitor-secret`. No debe configurarse en el `.env`, borrarse ni sustituirse: hacerlo invalidaria las identidades anonimas existentes.

## Reglas de Firestore

Fusiona estos bloques dentro del `match /databases/{database}/documents` de las reglas que ya usa produccion. No reemplaces las reglas existentes de playlists o perfiles:

```text
match /albums/{albumId} {
  allow read, write: if false;

  match /tracks/{entryId} {
    allow read, write: if false;
  }
}

match /albumFollows/{followId} {
  allow read, write: if false;
}

match /albumRevealProgress/{progressId} {
  allow read, write: if false;
}
```

Firebase Admin ignora estas reglas de cliente, por lo que Express sigue funcionando. Despliega las reglas antes de exponer los endpoints en produccion.

## Orden de despliegue

1. Desplegar las reglas de Firestore.
2. Copiar `backend/server.js`, `backend/albums.js` y `backend/.env.example` al servidor externo.
3. Desplegar la web para publicar `/api/admins`, que expone la lista general ya configurada en Vercel.
4. Reiniciar el servicio de musica y comprobar `GET /albums`.
5. Desplegar la web.
6. Publicar una APK nueva, porque el bloqueo nativo de primera escucha modifica Java/Media3.

La version Android preparada para esta funcionalidad es `1.0.14` (`versionCode 15`). El manifiesto publico de actualizaciones debe mantenerse en la ultima APK realmente publicada hasta que el workflow termine correctamente.

## Albumes en Radio

La busqueda de playlists de `/radio` incluye los albumes que tengan al menos una pista disponible para la identidad actual. En modo Revelacion solo se muestran y se anaden las pistas ya estrenadas y reveladas por ese usuario o visitante. Fuera de Revelacion se incluyen todas las pistas cuya fecha de estreno ya haya llegado.

El cliente envia los `entryId` visibles, pero Express vuelve a comprobar el reloj del servidor y el progreso de Revelacion antes de resolver las canciones. Una pista futura o misteriosa nunca debe entrar en la cola aunque se manipule la peticion.
