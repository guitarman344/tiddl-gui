#!/bin/zsh
# Doppio clic per avviare tiddl GUI
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null; then
  echo "❌ Node.js non trovato. Installalo con: brew install node"; read; exit 1
fi
if ! command -v tiddl >/dev/null; then
  echo "⚠️  tiddl non trovato. Installalo con: pipx install tiddl   (poi riavvia questo file)"
fi
[ -d node_modules ] || npm install

# Chiude un'eventuale vecchia istanza rimasta aperta sulla porta 7432
OLD=$(lsof -ti tcp:7432 -sTCP:LISTEN)
if [ -n "$OLD" ]; then
  echo "🔁 Chiudo la vecchia versione ancora in esecuzione (PID $OLD)..."
  kill $OLD; sleep 1
fi

(sleep 2 && open "http://localhost:7432") &
node server.js
