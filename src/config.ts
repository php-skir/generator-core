import { z } from "zod";

export const DEFAULT_NAMESPACE = "Skir";

export const PhpNamespace = z.string().regex(
  /^[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)*$/u,
  "Namespace must be a canonical PHP namespace using ASCII identifier segments separated by single backslashes.",
);

export type PhpNamespace = z.infer<typeof PhpNamespace>;

export const Emit = z.enum(["both", "client", "server"]).default("both");

export type Emit = z.infer<typeof Emit>;
