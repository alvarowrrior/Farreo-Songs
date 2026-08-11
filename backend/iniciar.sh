#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"
echo "=============================================="
echo "  🎵 INICIANDO SERVIDOR DE MÚSICA FARREO..."
echo "=============================================="
echo ""
echo "El servidor está corriendo en el puerto 3001."
echo "Farreo accederá a él a través de tu dominio DDNS."
echo ""
echo "Pulsa CTRL+C para detenerlo."
echo "=============================================="

# Arrancar el servidor (en primer plano para que CTRL+C lo detenga)
exec node server.js
