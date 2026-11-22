#!/bin/bash
# Change to the directory where the script is located
cd "$(dirname "$0")"

# Use the CCL Lisp interpreter from the AIAces project
CCL_EXEC="/Users/chang/Anitgravity/Ace's/AIAces/ccl/dx86cl64"

# Run the game
"$CCL_EXEC" --load tic-tac-toe.lisp --eval "(quit)"

