#!/usr/bin/env node
// Exit-code shim so the bash entry points (bin/clover, bin/relay-serve) can ask the same question
// the Node launcher asks: may the relay start right now? 0 = yes (.claude/.relay-status reads ON),
// 1 = no. Prints nothing — the caller owns the message.
// The rule itself stays in one place, src/lifecycle.mjs. This file exists because src/*.mjs is ESM,
// which a bash-side `node -e` + require() one-liner cannot load; duplicating the rule into each
// shell script instead would give the switch three subtly different meanings.
import { relayEnabled } from '../src/lifecycle.mjs';

process.exit(relayEnabled() ? 0 : 1);
