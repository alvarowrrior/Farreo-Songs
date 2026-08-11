#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"
echo "=============================================="
echo "  🎵 INICIANDO SERVIDOR DE MÚSICA FARREO..."
echo "=============================================="
echo ""
echo "El servidor está corriendo en el puerto 3001."
echo "Farreo accederá a él a través de tu dominio DDNS."
echo "Capa de seguridad/coste Firestore: ACTIVADA."
echo ""
echo "Pulsa CTRL+C para detenerlo."
echo "=============================================="

# IMPORTANTE: el preload protege las mutaciones antiguas, limita uploads y
# optimiza las rutas que consultan Firestore. No arrancar con `node server.js`
# salvo para diagnostico deliberado.
exec node server-safe.js
