/**
 * Entrypoint resolved through `exports["./server"]`, by OpenCode 2 and, it
 * turned out, by OpenCode 1.x as well.
 *
 * OpenCode 2 tries `<package>/server` before `<package>` and wants a default
 * export with `id` and `setup`. OpenCode 1 (verified on 1.16.0 through
 * 1.18.34) resolves the very same subpath for an npm package and then
 * requires the default export to carry a `server()` function; without it
 * the plugin is dropped and the user sees "must default export an object
 * with server()". 0.5.0 and 0.5.1 shipped exactly that gap. So the default
 * export carries both: v2 calls `setup`, v1 calls `server`, each ignores the
 * other. `dist/index.js` stays as the entry for OpenCode 1 versions that do
 * not know the subpath. Keep this file free of a runtime import from
 * `@opencode/plugin`: `Plugin.define` is the identity function and the SDK
 * is a devDependency.
 */
import type { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { PLUGIN_ID } from "./constants.js"
import { discoverRawModels, fetchModelInfo } from "./discovery.js"
import { createDiscoveryCache, NeuronPlugin, type NeuronPluginFunction } from "./plugin.js"
import type { NeuronContext } from "./v2/context.js"
import { readDeclaredProviderIDs } from "./v2/declared.js"
import { consoleLogger, setupNeuron } from "./v2/plugin.js"

const plugin: Plugin.Plugin & { server: NeuronPluginFunction } = {
  id: PLUGIN_ID,
  /** OpenCode 1.x (object-export loader) calls this; it is the v1 plugin. */
  server: NeuronPlugin,
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
