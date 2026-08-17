// Rewrites PACKAGE_VERSION in src/constants.ts to match package.json.
// Wired into the `npm version` lifecycle hook (see package.json), so a
// release bump updates the constant and stages it into the version commit.
import { readFile, writeFile } from "node:fs/promises"

const { version } = JSON.parse(await readFile("package.json", "utf8"))
const path = "src/constants.ts"
const source = await readFile(path, "utf8")
const updated = source.replace(/^export const PACKAGE_VERSION = ".*"$/m, `export const PACKAGE_VERSION = "${version}"`)
if (updated === source && !source.includes(`PACKAGE_VERSION = "${version}"`)) {
  console.error(`sync-version: PACKAGE_VERSION line not found in ${path}`)
  process.exit(1)
}
await writeFile(path, updated, "utf8")
console.log(`sync-version: PACKAGE_VERSION = ${version}`)
