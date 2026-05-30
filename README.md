# Farreo

Farreo es una web privada para gestionar, escuchar y compartir canciones y playlists.

## Funcionalidades

- Biblioteca principal en `/`.
- Apartado de administracion en `/admin` para usuarios autorizados.
- Subida, edicion y eliminacion de canciones desde el panel musical.
- Creacion y gestion de playlists.
- Cada playlist tiene su propia ruta en `/playlist/[id]`.
- Reproductor con cola, aleatorio, pitch, volumen y enlaces compartibles.
- Login con Google opcional para perfil de usuario.

## Stack

| Capa | Tecnologia | Uso |
| --- | --- | --- |
| Framework | Next.js 16 | App Router y rutas web |
| Lenguaje | TypeScript | Tipado del proyecto |
| UI | React 19 | Interfaz interactiva |
| Estilos | Sass | SCSS modular por layout, componente y pagina |
| Auth | Firebase Auth | Login opcional con Google |
| Iconos | Lucide React | Iconografia del panel |

## Instalacion

```bash
npm install
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000).

## Variables

Configura las variables de Firebase si quieres usar login y perfil:

```bash
cp .env.local.example .env.local

NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_ADMIN_EMAILS=correo1@example.com,correo2@example.com
```

El panel de musica consume el servidor privado configurado en `components/PlaylistLibrary.tsx` y `components/PlaylistPlayer.tsx`.

## Estructura

```text
app/
  admin/
    page.tsx              # administracion de canciones
    playlist/page.tsx     # redirige a /admin
  playlist/[id]/page.tsx  # reproductor de playlist
  play/page.tsx           # reproductor compartible
  login/page.tsx          # login con Google
  perfil/page.tsx         # perfil de usuario
components/
  header.tsx
  PlaylistLibrary.tsx
  PlaylistPlayer.tsx
lib/
  firebase.ts
styles/
  pages/_playlist.scss
  pages/_home.scss
  pages/_login.scss
  pages/_profile.scss
```
