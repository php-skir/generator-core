import type { NormalizedModule } from "./model.js";
import { toPhpNamespaceSegment } from "./php-identifier.js";

export function normalizeModulePath(
  path: string,
): Omit<NormalizedModule, "records" | "methods"> {
  const pathParts = path.split("/");
  const sourceDirectory = pathParts.slice(0, -1).join("/");
  const namespaceSegments = pathParts
    .slice(0, -1)
    .map((part) => toPhpNamespaceSegment(part))
    .filter((part) => part !== "");

  return {
    path,
    sourceDirectory,
    namespaceSegments,
    moduleIdentity: namespaceSegments.length === 0 ? "_Root" : namespaceSegments.join("."),
  };
}
