/**
 * OpenCode 2.x entrypoint, resolved through `exports["./server"]`.
 *
 * OpenCode 2 tries `<package>/server` before `<package>`, and OpenCode 1
 * only ever imports `<package>`, so the two majors never see each other's
 * module. Keep this file free of a runtime import from `@opencode/plugin`:
 * `Plugin.define` is the identity function and the SDK is a devDependency.
 */
import type { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { PLUGIN_ID } from "./constants.js"
import { discoverRawModels, fetchModelInfo } from "./discovery.js"
import { createDiscoveryCache } from "./plugin.js"
import type { NeuronContext } from "./v2/context.js"
import { readDeclaredProviderIDs } from "./v2/declared.js"
import { consoleLogger, setupNeuron } from "./v2/plugin.js"

const plugin: Plugin.Plugin = {
  id: PLUGIN_ID,
  async setup(context) {
    // `NeuronContext` is the structural subset this plugin uses; the SDK's
    // branded ids are not assignable from plain strings, hence the cast.
    return setupNeuron(context as unknown as NeuronContext, {
      discoverRawModels,
      fetchModelInfo,
      readDeclaredProviders: (directory) => readDeclaredProviderIDs(directory, process.env, homedir()),
      log: consoleLogger(),
      cache: createDiscoveryCache(),
    })
  },
}

export default plugin
