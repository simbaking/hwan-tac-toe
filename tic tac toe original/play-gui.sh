#!/bin/bash
cd "$(dirname "$0")"

# Kill any existing process on port 8085 just in case
lsof -ti:8085 | xargs kill -9 2>/dev/null

CCL_EXEC="/Users/chang/Anitgravity/Ace's/AIAces/ccl/dx86cl64"

# Run the Lisp server in the background silently
nohup "$CCL_EXEC" --load server.lisp > server.log 2>&1 &

# Wait a moment for the server to start, then open the browser
sleep 2
open http://localhost:8085

