
#!/bin/bash

cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
pid_file=".demo-server.pid"

finish() {
  printf '%s\n' "$1"
  if [ -t 0 ]; then read -r -p "Press Return to close this window…" _; fi
}

if [ ! -f "$pid_file" ]; then
  finish "No server started by the launcher was found. If you started it in Terminal, press Control-C there."
  exit 0
fi

server_pid=$(cat "$pid_file")
case "$server_pid" in
  ''|*[!0-9]*) finish "The saved server ID is invalid. No process was stopped."; exit 1 ;;
esac

if ! kill -0 "$server_pid" 2>/dev/null; then
  rm -f "$pid_file"
  finish "The Galleypost server was already stopped."
  exit 0
fi

if ! ps -p "$server_pid" -o command= | grep -Fq "$(pwd)/server.js" ||
   ! lsof -nP -a -p "$server_pid" -iTCP:8080 -sTCP:LISTEN -t 2>/dev/null | grep -q "^${server_pid}$"; then
  finish "The saved ID belongs to another process. No process was stopped."
  exit 1
fi

if kill -TERM "$server_pid" 2>/dev/null; then
  for ((attempt = 0; attempt < 40; attempt++)); do
    if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if kill -0 "$server_pid" 2>/dev/null; then
    finish "The server is still stopping. Wait a moment, then try Stop again."
    exit 1
  fi
  rm -f "$pid_file"
  finish "Galleypost stopped. You can close the browser tab."
else
  finish "Could not stop the Galleypost server. Try again or close its Terminal process."
  exit 1
fi