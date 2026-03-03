#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_WEB_DIR="$ROOT_DIR/mobile/dist-web"
INDEX_HTML="$DIST_WEB_DIR/index.html"
VOICE_BUTTON_FILE="$ROOT_DIR/mobile/src/components/VoiceButton.tsx"
HOME_SCREEN_FILE="$ROOT_DIR/mobile/src/screens/HomeScreen.tsx"
USE_VOICE_FILE="$ROOT_DIR/mobile/src/hooks/useVoice.tsx"
WEBSOCKET_FILE="$ROOT_DIR/mobile/src/services/websocket.ts"

failures=0

print_result() {
  local status="$1"
  local label="$2"
  local detail="$3"
  printf '%-8s %s\n' "$status" "$label"
  if [ -n "$detail" ]; then
    printf '         %s\n' "$detail"
  fi
}

check_file_exists() {
  local path="$1"
  local label="$2"
  if [ -f "$path" ]; then
    print_result "[PASS]" "$label" "$path"
  else
    print_result "[FAIL]" "$label" "$path"
    failures=$((failures + 1))
  fi
}

check_dir_exists() {
  local path="$1"
  local label="$2"
  if [ -d "$path" ]; then
    print_result "[PASS]" "$label" "$path"
  else
    print_result "[FAIL]" "$label" "$path"
    failures=$((failures + 1))
  fi
}

check_dist_bundle() {
  echo "=== Dist-Web Bundle Checks ==="
  check_dir_exists "$DIST_WEB_DIR" "dist-web directory exists"
  check_file_exists "$INDEX_HTML" "dist-web index exists"

  if [ ! -f "$INDEX_HTML" ]; then
    return
  fi

  mapfile -t script_sources < <(
    rg -No 'src="([^"]+\.js)"' "$INDEX_HTML" \
      | sed -E 's/.*src="([^"]+)".*/\1/'
  )

  if [ "${#script_sources[@]}" -eq 0 ]; then
    print_result "[FAIL]" "index.html references JS bundles" "No <script src=\"...js\"> entries found"
    failures=$((failures + 1))
    return
  fi

  print_result "[PASS]" "index.html references JS bundles" "Found ${#script_sources[@]} script source(s)"

  local syntax_failures=0

  for src in "${script_sources[@]}"; do
    local rel="${src#/}"
    local bundle_path="$DIST_WEB_DIR/$rel"

    if [ ! -s "$bundle_path" ]; then
      print_result "[FAIL]" "Bundle file exists and is non-empty" "$bundle_path"
      failures=$((failures + 1))
      continue
    fi

    print_result "[PASS]" "Bundle file exists and is non-empty" "$bundle_path"

    if node --check "$bundle_path" >/tmp/snapclaw_node_check.out 2>/tmp/snapclaw_node_check.err; then
      print_result "[PASS]" "Bundle parses without syntax errors" "$rel"
    else
      local err
      err="$(head -n 3 /tmp/snapclaw_node_check.err | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
      print_result "[FAIL]" "Bundle parses without syntax errors" "$rel :: $err"
      failures=$((failures + 1))
      syntax_failures=$((syntax_failures + 1))
    fi
  done

  if [ "$syntax_failures" -eq 0 ]; then
    print_result "[PASS]" "JavaScript bundle syntax check" "All referenced bundles parsed by Node"
  else
    print_result "[FAIL]" "JavaScript bundle syntax check" "$syntax_failures bundle(s) failed parsing"
  fi
}

feature_status() {
  local name="$1"
  local implemented="$2"
  local detail="$3"
  if [ "$implemented" = "yes" ]; then
    print_result "[PASS]" "$name" "$detail"
  else
    print_result "[FAIL]" "$name" "$detail"
    failures=$((failures + 1))
  fi
}

check_features() {
  echo
  echo "=== Voice Feature Checks ==="

  local has_volume_meter="no"
  if rg -q 'createAnalyser|getByteTimeDomainData|requestAnimationFrame' "$VOICE_BUTTON_FILE" \
    && ! rg -q 'Animated\.loop|pulse' "$VOICE_BUTTON_FILE"; then
    has_volume_meter="yes"
  fi
  feature_status \
    "VoiceButton: volume-based animation (no constant pulse)" \
    "$has_volume_meter" \
    "Signals: analyser + RAF meter present; no Animated.loop pulse"

  local has_bouncing_dots="no"
  if rg -q 'bounc|loadingDots|processingDots|dot1|dot2|dot3' "$HOME_SCREEN_FILE"; then
    has_bouncing_dots="yes"
  fi
  feature_status \
    "HomeScreen: bouncing dots during processing" \
    "$has_bouncing_dots" \
    "Current processing UI appears to use ActivityIndicator spinner"

  local has_safari_resume="no"
  if rg -q "const ensureWebAudioContextActive = useCallback" "$USE_VOICE_FILE" \
    && rg -q "audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function'" "$USE_VOICE_FILE" \
    && awk '
      /const playAudioResponse = useCallback\(async/ { in_block=1 }
      in_block && /const audioCtx = await ensureWebAudioContextActive\(\);/ { has_helper_call=1 }
      in_block && /audioCtx.state !== '\''running'\'' && typeof audioCtx.resume === '\''function'\''/ { has_playback_resume=1 }
      in_block && /source.start\(0\);/ { in_block=0 }
      END { exit ! (has_helper_call && has_playback_resume) }
    ' "$USE_VOICE_FILE"; then
    has_safari_resume="yes"
  fi
  feature_status \
    "useVoice: Safari AudioContext resume handling" \
    "$has_safari_resume" \
    "Expected: suspended-context resume guard plus playback-path ensure/resume before source.start()"

  local has_ws_backoff="no"
  if rg -q 'setTimeout' "$WEBSOCKET_FILE" \
    && rg -q 'reconnect|retry|backoff' "$WEBSOCKET_FILE"; then
    has_ws_backoff="yes"
  fi
  feature_status \
    "websocket.ts: reconnection logic with backoff" \
    "$has_ws_backoff" \
    "Expected reconnect attempt tracking + delayed retry/backoff scheduling"
}

print_summary() {
  echo
  echo "=== Summary ==="
  if [ "$failures" -eq 0 ]; then
    echo "PASS: all checks passed"
  else
    echo "FAIL: $failures check(s) failed"
  fi
}

main() {
  check_dist_bundle
  check_features
  print_summary

  if [ "$failures" -eq 0 ]; then
    exit 0
  fi
  exit 1
}

main "$@"
