
#!/bin/bash

cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
url="http://127.0.0.1:8080/"
pid_file=".demo-server.pid"
lock_dir=".demo-launch.lock"

fail() {
  printf '\nCould not start Galleypost.\n%s\n\n' "$1" >&2
  if [ -t 0 ]; then read -r -p "Press Return to close this window…" _; fi
  exit 1
}

is_our_server() {
  curl --silent --fail --max-time 2 "${url}api/health" 2>/dev/null | grep -q '"app":"galleypost"'
}

# A simultaneous second double-click must not install or start another copy.
if ! mkdir "$lock_dir" 2>/dev/null; then
  [ -d "$lock_dir" ] || fail "This folder is not writable. Move it to Documents and try again."
  lock_pid=$(cat "$lock_dir/pid" 2>/dev/null)
  case "$lock_pid" in ''|*[!0-9]*) lock_pid=0 ;; esac
  if [ "$lock_pid" -gt 0 ] && ! kill -0 "$lock_pid" 2>/dev/null; then
    rm -f "$lock_dir/pid"
    rmdir "$lock_dir" 2>/dev/null || fail "Another start is in progress. Wait a moment, then try again."
    mkdir "$lock_dir" || fail "Could not prepare the launcher. Try again."
  else
    printf 'The launcher is already starting. Please wait for the browser to open.\n'
    exit 0
  fi
fi
trap 'rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null' EXIT
trap 'exit 1' INT TERM
printf '%s\n' "$$" > "$lock_dir/pid" || fail "This folder is not writable. Move it to your Documents folder and try again."

if is_our_server; then
  printf 'Galleypost is already running. Opening it now.\n'
  open "$url" || fail "The server is running. Open $url in your browser."
  exit 0
fi

if lsof -nP -iTCP:8080 -sTCP:LISTEN -t 2>/dev/null | grep -q .; then
  fail "Port 8080 is being used by another application. Stop that application, then try again. No process was stopped."
fi

command -v node >/dev/null 2>&1 || fail "Node.js is missing. Install the LTS version from https://nodejs.org, then try again."
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major>22 || (major===22 && minor>=13) ? 0 : 1)' ||
  fail "This demo needs Node.js 22.13 or newer. Install the LTS version from https://nodejs.org."
[ -f server.js ] && [ -f package-lock.json ] && [ -f index.html ] ||
  fail "Application files are missing. Download the complete repository again and keep the files together."

if ! node --input-type=module -e "await import('openai')" >/dev/null 2>&1; then
  command -v npm >/dev/null 2>&1 || fail "The Node.js installation is missing npm. Reinstall Node.js LTS, then try again."
  printf '\nFirst launch: the app needs to download its software dependencies from npm.\nAn internet connection is needed. No API key is required.\nInstall them now? [y/N] '
  read -r install_answer
  case "$install_answer" in
    y|Y|yes|YES)
      printf 'Installing dependencies. Please keep this window open…\n'
      env -u OPENAI_API_KEY npm ci --omit=dev --no-audit --no-fund ||
        fail "Dependency installation failed. Check your internet connection and that this folder is writable, then try again."
      ;;
    *) fail "Installation cancelled. Double-click Start again when you are ready." ;;
  esac
fi

printf 'Starting the local demo. Live AI is optional; configure your own key in .env only if needed.\n'
nohup env -u OPENAI_API_KEY -u OPENAI_MODEL PORT=8080 node --env-file-if-exists="$PWD/.env" "$PWD/server.js" >/dev/null 2>&1 &
server_pid=$!
if ! printf '%s\n' "$server_pid" > "$pid_file"; then
  kill -TERM "$server_pid" 2>/dev/null
  fail "Could not save the server ID. Move the app to a writable folder and try again."
fi

for ((attempt = 0; attempt < 40; attempt++)); do
  if is_our_server; then
    printf 'Galleypost is ready at %s\n' "$url"
    open "$url" || fail "The server started. Open $url in your browser."
    exit 0
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
  sleep 0.25
done

kill -TERM "$server_pid" 2>/dev/null
rm -f "$pid_file"
fail "The server did not start. Check that port 8080 is free. If you edited .env, check its settings, then try again."