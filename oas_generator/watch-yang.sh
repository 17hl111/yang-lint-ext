#!/usr/bin/env bash
# watch-yang.sh - watch for changes to .yang files and regenerate swagger.json + OAS3
set -euo pipefail

# --- configuration (env overrides allowed) ---
WATCH_DIR="${WATCH_DIR:-.}"                       # directory to watch (recursive)
MODULES="${MODULES:-$1}"
MODEL_FILE="${MODEL_FILE:-$1/$2}"
MODEL_FILE_NAME="${MODEL_FILE_NAME:-$2}"          # main file
ANNOTATION=${ANNOTATION:-$3}                      # annotation flag to apply endpoint extensions
OUTPUT="${OUTPUT:-output/swagger.json}"           # swagger.json file path
OAS_OUTPUT="${OAS_OUTPUT:-output/oas3.json}"      # OAS3 output file path
IMAGE="${IMAGE:-localhost/yanger:latest}"         # local Podman image name (unused in-container)
EXTRA_ARGS="${EXTRA_ARGS:-}"                      # any extra args to yanger
DEBOUNCE_SEC="${DEBOUNCE_SEC:-1}"                 # debounce (seconds)
TMP_LOCK="${TMP_LOCK:-watch-yang.lock}"
LOGFILE="${LOGFILE:-watch-yang.log}"
SKIP_INITIAL_RUN="${SKIP_INITIAL_RUN:-0}"         # set to 1 to skip the startup run

# convenience env: set WATCH_USE_POLLING=true to force the watchdog polling observer (useful with Windows mounts)
WATCH_USE_POLLING="${WATCH_USE_POLLING:-}"

# ensure output dir exists
mkdir -p "$(dirname "${OUTPUT}")"

# --- logging helper ---
log() { printf '%s  %s\n' "$(date --iso-8601=seconds)" "$*" >> "$LOGFILE"; }

# -------------------------
# Auto-detect whether we should enable polling
# (useful when running inside a Linux container with a Windows-host mount)
#  - honors explicit WATCH_USE_POLLING if set
#  - inspects common markers (/run/desktop, /host_mnt) and filesystem type of WATCH_DIR
#  - turns on polling for 9p, fuse, cifs, smb, drvfs, virtiofs, fuseblk, etc.
# -------------------------
_auto_enable_polling_if_needed() {
  if [ -n "${WATCH_USE_POLLING:-}" ]; then
    log "WATCH_USE_POLLING explicitly set; respecting it."
    return 0
  fi

  # Only force polling if really running on Windows/OSX host mount
  if [ -d "/run/WSL" ] || grep -qi microsoft /proc/version 2>/dev/null; then
    WATCH_USE_POLLING=1
    log "Detected WSL kernel; enabling polling."
    return 0
  fi

  if [ -d "/host_mnt" ] || [ -d "/run/desktop" ]; then
    WATCH_USE_POLLING=1
    log "Detected Docker Desktop host mount; enabling polling."
    return 0
  fi

  if command -v stat >/dev/null 2>&1; then
    fstype=$(stat -f -c %T -- "${WATCH_DIR}" 2>/dev/null || echo unknown)
    case "${fstype}" in
      9p|fuse*|cifs|smb*|drvfs|virtiofs|fuseblk)
        WATCH_USE_POLLING=1
        log "Filesystem type '${fstype}' requires polling; enabling."
        ;;
      *)
        log "Filesystem type '${fstype}'; using native inotify."
        ;;
    esac
  fi
}


# call the auto-detection early so the rest of the script can rely on WATCH_USE_POLLING
_auto_enable_polling_if_needed

# --- helper: run yanger (direct, inside container) ---
run_pipeline() {
  log "=> regenerating ${OUTPUT} (model: ${MODEL_FILE})"
  # call yanger directly (yanger will have been built in the image)
  if ! yanger -p "${MODULES}" -t expand -f swagger \
      --swagger-tag-mode resources \
      --swagger-top-resource data \
      "${MODEL_FILE}" -o "${OUTPUT}" ${EXTRA_ARGS} >> "$LOGFILE" 2>&1; then
    local rc=$?
    log "=> yanger FAILED (rc=${rc}). See $LOGFILE for details."
    return $rc
  fi
  log "=> Swagger generation complete"

  # convert swagger.json to OAS3 (swagger2openapi available globally)
  log "=> converting ${OUTPUT} to ${OAS_OUTPUT} (using swagger2openapi)"
  if ! swagger2openapi "${OUTPUT}" -o "${OAS_OUTPUT}" >> "$LOGFILE" 2>&1; then
      log "=> swagger2openapi FAILED"
      return 1
  fi
  log "=> OAS3 generation complete"

  # annotation/optimization step
  YANG_OPT_DIR="${YANG_OPT_DIR:-/opt/yang_optimization}"

  if [ -f "${OAS_OUTPUT}" ] && [ "${ANNOTATION}" = "true" ]; then
      log "=> applying Endpoint optimization on ${OAS_OUTPUT} and ${MODEL_FILE} (using API optimization algorithms)"

      # ensure image-local temp dir exists
      mkdir -p "${YANG_OPT_DIR}/temp"

      # copy module .yang files into temp every run (so updated modules are used)
      if [ -d "${MODULES}" ]; then
          cp "${MODULES}"/*.yang "${YANG_OPT_DIR}/temp/" 2>/dev/null || true
      else
          log "=> WARNING: MODULES directory '${MODULES}' not found; skipping module copy."
      fi

      # copy utils only once: marker file prevents repeated copying
      if [ ! -f "${YANG_OPT_DIR}/.utils_installed" ]; then
          if [ -d "${YANG_OPT_DIR}/utils" ]; then
              cp -r "${YANG_OPT_DIR}/utils" "${YANG_OPT_DIR}/temp/" 2>/dev/null || true
              touch "${YANG_OPT_DIR}/.utils_installed"
              log "=> yang_optimization utils copied to temp (first-time install)."
          else
              log "=> WARNING: ${YANG_OPT_DIR}/utils not found inside image."
          fi
      fi

      # decide whether to pass absolute or relative OAS path to the helper script
      if [[ "${OAS_OUTPUT}" = /* ]]; then
          OAS_ARG="${OAS_OUTPUT}"
      else
          OAS_ARG="../${OAS_OUTPUT}"
      fi

      # run python optimization code from the in-image yang_optimization dir
      cd "${YANG_OPT_DIR}" || { log "=> failed to cd to ${YANG_OPT_DIR}"; exit 1; }

      # regenerate the yang library (this uses temp/ which now has modules + utils)
      python3 fill_yang_library.py || log "=> fill_yang_library.py exited non-zero"

      # regenerate the OAS using the provided OAS path and model file name
      python3 regenerate_oas.py "${OAS_ARG}" "${MODEL_FILE_NAME}" || {
          log "=> regenerate_oas.py FAILED for ${OAS_ARG}"
      }

      cd - >/dev/null || true
      log "=> OAS3 enhancement complete"
  fi

  return 0
}

# --- handle --run-once flag (used by the Python watcher to call the pipeline) ---
for a in "$@"; do
  if [ "$a" = "--run-once" ]; then
    run_pipeline
    exit $?
  fi
done

# --- cleanup on exit ---
on_exit() {
  log "watch-yang.sh exiting"
}
trap on_exit EXIT

# --- perform an initial regeneration (unless skipped) ---
if [[ "${SKIP_INITIAL_RUN}" != "1" ]]; then
  (
    flock -n 200 || { log "Initial run: another run is active; skipping initial regeneration."; true; }
    if ! run_pipeline; then
      log "Initial regeneration failed; watcher will continue and try again on file changes."
    else
      log "Initial regeneration completed successfully."
    fi
  ) 200>"$TMP_LOCK"
else
  log "SKIP_INITIAL_RUN=1: skipping initial regeneration."
fi

# ---------------------------------------------------------------------------
# Watcher: prefer Python/watchdog for cross-platform compatibility.
# If python3+watchdog is available, write a tiny watcher program to /tmp and run it.
# If not available, fall back to inotifywait (Linux only).
# ---------------------------------------------------------------------------

python_watchdog_available() {
  # require python3
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi

  # If a baked watcher script exists and is executable, consider it available
  if [ -x /usr/local/bin/watcher.py ]; then
    return 0
  fi

  # Otherwise check whether the watchdog Python package is importable
  python3 - <<'PY' >/dev/null 2>&1
import importlib, sys
spec = importlib.util.find_spec("watchdog")
sys.exit(0 if spec is not None else 1)
PY
  return $?
}

if python_watchdog_available; then
  log "Using baked Python watchdog for cross-platform watching (debounce=${DEBOUNCE_SEC}s)"
  # Build the command that runs this script once (absolute path)
  THIS_SCRIPT="$(realpath "$0")"
  CMD="bash ${THIS_SCRIPT} --run-once"
  POLL_FLAG=""
  if [ -n "${WATCH_USE_POLLING:-}" ]; then
    POLL_FLAG="--use-polling"
  fi
  # run the baked watcher
  python3 /usr/local/bin/watcher.py --watchdir "${WATCH_DIR}" --pattern "*.yang" --cmd "${CMD}" --debounce "${DEBOUNCE_SEC}" --logfile "${LOGFILE}" ${POLL_FLAG}

  else
    log "ERROR: neither Python watchdog nor inotifywait are available — cannot watch files."
    echo "ERROR: neither Python watchdog nor inotifywait are available — cannot watch files." >&2
    exit 1
  fi
