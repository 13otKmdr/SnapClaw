#!/usr/bin/env bash
# SnapClaw — phone-only Expo Go startup helper
# Detects your LAN IP and prints exact setup steps for scanning via Expo Go.
set -euo pipefail

LAN_IP=""

# Detect LAN IP: Linux (ip route), then macOS/BSD (ifconfig)
if command -v ip &>/dev/null; then
  LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' || true)
fi

if [[ -z "$LAN_IP" ]] && command -v ifconfig &>/dev/null; then
  LAN_IP=$(ifconfig 2>/dev/null \
    | grep -E 'inet [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
    | grep -v '127\.0\.0\.1' \
    | awk '{print $2}' \
    | head -1)
fi

if [[ -z "$LAN_IP" ]]; then
  LAN_IP="<YOUR-LAN-IP>"
  echo ""
  echo "WARNING: Could not auto-detect LAN IP. Replace <YOUR-LAN-IP> below manually."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SnapClaw — Phone-Only Setup (Expo Go)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "STEP 1  Start the backend (from repo root):"
echo ""
echo "    source venv/bin/activate"
echo "    uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload"
echo ""
echo "STEP 2  Create/update mobile/.env with your LAN IP:"
echo ""
echo "    EXPO_PUBLIC_API_URL=http://${LAN_IP}:8000"
echo "    EXPO_PUBLIC_WS_URL=ws://${LAN_IP}:8000"
echo ""
echo "    NOTE: Both phone and dev machine must be on the same Wi-Fi."
echo "    For phone on a different network (e.g. cellular), use a tunnel:"
echo ""
echo "    EXPO_PUBLIC_API_URL=https://<your-tunnel-domain>"
echo "    EXPO_PUBLIC_WS_URL=wss://<your-tunnel-domain>"
echo ""
echo "STEP 3  Start Metro (same LAN):"
echo ""
echo "    cd mobile && npx expo start"
echo ""
echo "    Or for phone on a different network:"
echo ""
echo "    cd mobile && npx expo start --tunnel"
echo "    (requires: npm install -g @expo/ngrok@^4.1.0)"
echo ""
echo "STEP 4  Open on your phone:"
echo ""
echo "    iOS:     Open Camera app, scan the QR code shown by Metro"
echo "    Android: Open Expo Go, tap 'Scan QR code', scan the QR code"
echo ""
echo "TROUBLESHOOTING"
echo "  - App shows 'Offline': backend may not be reachable. Confirm"
echo "      curl http://${LAN_IP}:8000/health   returns {\"status\":\"healthy\"}"
echo "  - iOS simulator: use http://localhost:8000 (not the LAN IP)"
echo "  - App shows 'Voice server offline — using text mode':"
echo "      set EXPO_PUBLIC_REALTIME_ENABLED=true in mobile/.env to enable"
echo "      realtime WS, or leave unset to use REST text mode."
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
