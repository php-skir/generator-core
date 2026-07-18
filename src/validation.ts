import { z } from "zod";

import type { NormalizedSchema } from "./model.js";

export const ValidationRule = z.string().min(
  1,
  "Validation rules must be non-empty strings.",
);
export const ValidationConfig = z.record(
  z.string(),
  z.record(
    z.string(),
    z.record(z.string(), z.array(ValidationRule).min(1)),
  ),
).default({});

export type ValidationConfig = z.infer<typeof ValidationConfig>;
export type ResolvedValidationRules = ReadonlyMap<
  string,
  ReadonlyMap<string, readonly string[]>
>;

export function resolveValidationRules(
  schema: NormalizedSchema,
  config: ValidationConfig,
): ResolvedValidationRules {
  const resolved = new Map<string, ReadonlyMap<string, readonly string[]>>();

  for (const [modulePath, configuredRecords] of Object.entries(config)) {
    const module = schema.modules.find((candidate) => candidate.path === modulePath);

    if (module === undefined) {
      throw new Error(`Unknown validation module ${JSON.stringify(modulePath)}.`);
    }

    for (const [qualifiedName, configuredFields] of Object.entries(configuredRecords)) {
      const identity = `${modulePath}::${qualifiedName}`;
      const record = module.records.find((candidate) => candidate.identity === identity);

      if (record === undefined) {
        throw new Error(`Unknown validation record ${JSON.stringify(identity)}.`);
      }

      const rulesByField = new Map<string, readonly string[]>();

      for (const [fieldName, rules] of Object.entries(configuredFields)) {
        const fieldSelector = `${identity}.${fieldName}`;
        const field = record.fields.find(
          (candidate) => candidate.kind === "field" && candidate.name === fieldName,
        );

        if (field === undefined) {
          const removedField = record.fields.find(
            (candidate) => (
              candidate.kind === "removed"
              && String(candidate.number) === fieldName
            ),
          );

          if (removedField !== undefined) {
            throw new Error(
              `Validation field ${JSON.stringify(fieldSelector)} targets removed field number ${removedField.number}; only struct payload fields can receive validation.`,
            );
          }

          throw new Error(`Unknown validation field ${JSON.stringify(fieldSelector)}.`);
        }

        if (record.recordType === "enum") {
          throw new Error(
            `Validation field ${JSON.stringify(fieldSelector)} targets an enum variant; only struct payload fields can receive validation.`,
          );
        }

        if (!("hasPayload" in field) || field.hasPayload !== true) {
          throw new Error(
            `Validation field ${JSON.stringify(fieldSelector)} does not target a struct payload field.`,
          );
        }

        rulesByField.set(fieldName, [...rules]);
      }

      if (rulesByField.size > 0) {
        resolved.set(identity, rulesByField);
      }
    }
  }

  return resolved;
}
