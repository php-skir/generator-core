import type { GeneratedFile } from "./model.js";

export const SERVER_MANIFEST_VERSION = 1;

export interface ServerManifestMethod {
  readonly name: string;
  readonly enumCase: string;
  readonly phpMethod: string;
  readonly requestType: string;
  readonly requestClass: string | null;
  readonly responseType: string;
  readonly responseClass: string | null;
}

export interface ServerManifestModule {
  readonly name: string;
  readonly methodEnum: string;
  readonly methods: readonly ServerManifestMethod[];
}

export function generateServerManifestFile(
  generator: string,
  modules: readonly ServerManifestModule[],
): GeneratedFile {
  return {
    path: "skir-server-manifest.json",
    code: `${JSON.stringify({
      version: SERVER_MANIFEST_VERSION,
      generator,
      modules,
    }, null, 2)}\n`,
  };
}
