#!/usr/bin/env node

import { main } from "./command.js"

main().catch((error) => {
  process.stderr.write(`[error] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
