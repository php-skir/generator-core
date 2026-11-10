import type {
  Module as ProducerModule,
  RecordLocation as ProducerRecordLocation,
} from "skir-internal";

export interface SkirToken {
  readonly text: string;
}

export interface SkirDoc {
  readonly text: string;
}

export type SkirRecordNamePart =
  | string
  | SkirToken
  | { readonly token: string | SkirToken };

export type SkirType =
  | string
  | {
      readonly kind: string;
      readonly primitive?: string;
      readonly item?: SkirType;
      readonly other?: SkirType;
      readonly key?: unknown;
      readonly name?: string | SkirToken;
      readonly nameParts?: readonly SkirRecordNamePart[];
      readonly recordType?: "struct" | "enum";
    };

export type SkirField =
  | {
      readonly kind: "field";
      readonly name: string | SkirToken;
      readonly number: number;
      readonly type?: SkirType;
      readonly doc?: SkirDoc;
    }
  | {
      readonly kind: "removed";
      readonly number: number;
    };

export interface SkirRecord {
  readonly kind?: string;
  readonly key?: unknown;
  readonly name: string | SkirToken;
  readonly recordType?: "struct" | "enum";
  readonly fields?: readonly SkirField[];
  readonly removedNumbers?: readonly number[];
  readonly phpClassName?: string;
  readonly doc?: SkirDoc;
}

export interface SkirRecordLocation {
  readonly kind: "record-location";
  readonly record: SkirRecord;
  readonly recordAncestors?: readonly SkirRecord[];
  readonly modulePath?: string;
}

export interface SkirMethod {
  readonly kind: "method";
  readonly name: string | SkirToken;
  readonly number: number;
  readonly requestType?: SkirType;
  readonly responseType?: SkirType;
  readonly doc?: SkirDoc;
}

export interface SkirModule {
  readonly path: string;
  readonly records?: readonly (SkirRecord | SkirRecordLocation)[];
  readonly methods?: readonly SkirMethod[];
}

type Assert<T extends true> = T;
type ProducerModuleIsCompatible = Assert<ProducerModule extends SkirModule ? true : false>;
type ProducerRecordLocationIsCompatible = Assert<ProducerRecordLocation extends SkirRecordLocation ? true : false>;

export type NormalizedType =
  | {
      readonly kind:
        | "bool"
        | "int32"
        | "int64"
        | "hash64"
        | "float32"
        | "float64"
        | "string"
        | "bytes"
        | "timestamp"
        | "mixed";
    }
  | { readonly kind: "array"; readonly item: NormalizedType }
  | { readonly kind: "optional"; readonly inner: NormalizedType }
  | {
      readonly kind: "record";
      readonly recordIdentity: string;
      readonly recordType: "struct" | "enum";
    };

export interface NormalizedField {
  readonly kind: "field";
  readonly name: string;
  readonly number: number;
  readonly hasPayload: true;
  readonly type: NormalizedType;
  /** Doc comment text of the field or wrapper variant, when it has one. */
  readonly doc?: string;
}

export interface NormalizedEnumConstant {
  readonly kind: "field";
  readonly name: string;
  readonly number: number;
  readonly hasPayload: false;
  /** Doc comment text of the constant variant, when it has one. */
  readonly doc?: string;
}

export interface NormalizedRecord {
  readonly identity: string;
  readonly modulePath: string;
  readonly qualifiedName: string;
  /**
   * Schema-level record id, `<module path>:<qualified name>`, matching the
   * type signature of upstream Skir type descriptors.
   */
  readonly recordId: string;
  /** Doc comment text of the record, when it has one. */
  readonly doc?: string;
  readonly recordType: "struct" | "enum";
  readonly phpClassName?: string;
  readonly fields: readonly (
    | NormalizedField
    | NormalizedEnumConstant
    | { readonly kind: "removed"; readonly number: number }
  )[];
  readonly key?: string;
}

export interface NormalizedMethod {
  readonly name: string;
  readonly number: number;
  readonly requestType: NormalizedType;
  readonly responseType: NormalizedType;
  /** Doc comment text of the method, when it has one. */
  readonly doc?: string;
}

export interface NormalizedModule {
  readonly path: string;
  readonly sourceDirectory: string;
  readonly namespaceSegments: readonly string[];
  readonly moduleIdentity: string;
  readonly records: readonly NormalizedRecord[];
  readonly methods: readonly NormalizedMethod[];
}

export interface NormalizedSchema {
  readonly modules: readonly NormalizedModule[];
  readonly recordsByIdentity: ReadonlyMap<string, NormalizedRecord>;
  readonly recordsByKey: ReadonlyMap<string, NormalizedRecord>;
}

export interface CoreGeneratorInput {
  readonly modules: readonly SkirModule[];
  readonly recordMap?: ReadonlyMap<string, SkirRecordLocation>;
}

export interface GeneratedFile {
  readonly path: string;
  readonly code: string;
}
