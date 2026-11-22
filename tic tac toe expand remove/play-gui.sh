#!/bin/bash
cd "$(dirname "$0")"

# Kill any existing process on port 8086 just in case
lsof -ti:8086 | xargs kill -9 2>/dev/null

# Run the Node.js server in the background silently
nohup node server.js > server.log 2>&1 &

# Wait for the server to start listening before opening the browser
for i in {1..30}; do
    if curl -s http://localhost:8086/api/state >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done
open -a "Google Chrome" http://localhost:8086

