import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  generatePhp,
  normalizeSchema,
  phpSingleQuotedLiteral,
  renderDocArgument,
  renderRecordMetadataArguments,
  toClassName,
  type GeneratedFile,
  type NormalizedRecord,
  type NormalizedType,
  type PhpTargetAdapter,
  type RenderContext,
  type SkirModule,
  type SkirRecord,
  type SkirRecordLocation,
  type StructRenderRequest,
} from "../src/index.js";

const TRICKY_DOC = "It's a \"quote\", a back\\slash\nand a second line.\\";

class MinimalAdapter implements PhpTargetAdapter {
  public readonly id = "metadata-adapter";

  public recordClassName(record: NormalizedRecord): string {
    return toClassName(record.qualifiedName.replaceAll(".", "_"));
  }

  public renderStruct({ record, context }: StructRenderRequest): GeneratedFile {
    const className = context.names.namesByIdentity.get(record.identity) ?? "Missing";

    return {
      path: context.pathPrefix === "" ? `${className}.php` : `${context.pathPrefix}/${className}.php`,
      code: `struct ${record.recordId}\n`,
    };
  }

  public phpType(type: NormalizedType, context: RenderContext): string {
    if (type.kind === "record") {
      return context.names.namesByIdentity.get(type.recordIdentity) ?? "Missing";
    }

    return type.kind === "string" ? "string" : "mixed";
  }

  public toSkirExpression(_type: NormalizedType, expression: string): string {
    return expression;
  }

  public fromSkirExpression(_type: NormalizedType, expression: string): string {
    return expression;
  }

  public clientResponseExpression(_type: NormalizedType, expression: string): string {
    return expression;
  }

  public manifestObjectClass(): string | null {
    return null;
  }
}

const invitation: SkirRecord = {
  kind: "record",
  key: "invitation-key",
  name: "Invitation",
  recordType: "struct",
  doc: { text: "An invitation to join a team." },
  fields: [
    { kind: "field", name: "email", number: 0, type: "string", doc: { text: "Where it was sent." } },
    { kind: "field", name: "token", number: 1, type: "string" },
    { kind: "field", name: "note", number: 2, type: "string", doc: { text: "  \n " } },
  ],
};
const invitationStatus: SkirRecord = {
  kind: "record",
  key: "invitation-status-key",
  name: "Status",
  recordType: "enum",
  doc: { text: TRICKY_DOC },
  fields: [
    { kind: "field", name: "pending", number: 1 },
    { kind: "field", name: "accepted", number: 2, doc: { text: "The invitee joined." } },
    { kind: "field", name: "declined", number: 3, type: "string", doc: { text: "Carries the reason." } },
    { kind: "field", name: "expired_at", number: 4, type: "timestamp" },
  ],
};
const client: SkirRecord = {
  kind: "record",
  key: "client-key",
  name: "Client",
  recordType: "enum",
  fields: [{ kind: "field", name: "tablet", number: 1 }],
};
const nestedStatusLocation: SkirRecordLocation = {
  kind: "record-location",
  record: invitationStatus,
  recordAncestors: [invitation, invitationStatus],
  modulePath: "identity/identity.skir",
};
const modules: readonly SkirModule[] = [{
  path: "identity/identity.skir",
  records: [invitation, nestedStatusLocation, client],
  methods: [
    {
      kind: "method",
      name: "GetInvitation",
      number: 10,
      requestType: "string",
      responseType: { kind: "record", key: "invitation-key", recordType: "struct" },
      doc: { text: "Returns the invitation." },
    },
    {
      kind: "method",
      name: "Ping",
      number: 11,
      requestType: "string",
      responseType: "string",
    },
    {
      kind: "method",
      name: "Tricky",
      number: 12,
      requestType: "string",
      responseType: "string",
      doc: { text: TRICKY_DOC },
    },
    {
      kind: "method",
      name: "Blank",
      number: 13,
      requestType: "string",
      responseType: "string",
      doc: { text: "   " },
    },
  ],
}];

function evaluatePhpExpression(expression: string): string {
  return execFileSync("php", ["-r", `echo ${expression};`], { encoding: "utf8" });
}

describe("type metadata normalization", () => {
  const schema = normalizeSchema({ modules });

  it("derives upstream-style record ids for top-level and nested records", () => {
    const records = schema.modules[0]?.records ?? [];

    expect(records.map((record) => record.recordId)).toEqual([
      "identity/identity.skir:Invitation",
      "identity/identity.skir:Invitation.Status",
      "identity/identity.skir:Client",
    ]);
    expect(records.map((record) => record.identity)).toEqual([
      "identity/identity.skir::Invitation",
      "identity/identity.skir::Invitation.Status",
      "identity/identity.skir::Client",
    ]);
    expect(schema.recordsByKey.get("invitation-status-key")?.recordId)
      .toBe("identity/identity.skir:Invitation.Status");
  });

  it("sets the record id on records known only through the record map", () => {
    const external: SkirRecord = { kind: "record", name: "Money", recordType: "struct", doc: { text: "An amount." } };
    const withRecordMap = normalizeSchema({
      modules: [],
      recordMap: new Map([[
        "money-key",
        {
          kind: "record-location",
          record: external,
          recordAncestors: [external],
          modulePath: "common/money.skir",
        },
      ]]),
    });

    expect(withRecordMap.recordsByKey.get("money-key")).toMatchObject({
      recordId: "common/money.skir:Money",
      doc: "An amount.",
    });
  });

  it("keeps record, field, variant, and method doc text and drops blank docs", () => {
    const [invitationRecord, statusRecord, clientRecord] = schema.modules[0]?.records ?? [];

    expect(invitationRecord?.doc).toBe("An invitation to join a team.");
    expect(statusRecord?.doc).toBe(TRICKY_DOC);
    expect(clientRecord).not.toHaveProperty("doc");
    expect(invitationRecord?.fields).toEqual([
      { kind: "field", name: "email", number: 0, hasPayload: true, type: { kind: "string" }, doc: "Where it was sent." },
      { kind: "field", name: "token", number: 1, hasPayload: true, type: { kind: "string" } },
      { kind: "field", name: "note", number: 2, hasPayload: true, type: { kind: "string" } },
    ]);
    expect(statusRecord?.fields).toEqual([
      { kind: "field", name: "pending", number: 1, hasPayload: false },
      { kind: "field", name: "accepted", number: 2, hasPayload: false, doc: "The invitee joined." },
      { kind: "field", name: "declined", number: 3, hasPayload: true, type: { kind: "string" }, doc: "Carries the reason." },
      { kind: "field", name: "expired_at", number: 4, hasPayload: true, type: { kind: "timestamp" } },
    ]);
    expect(schema.modules[0]?.methods.map((method) => method.doc)).toEqual([
      "Returns the invitation.",
      undefined,
      TRICKY_DOC,
      undefined,
    ]);
    expect(schema.modules[0]?.methods[1]).not.toHaveProperty("doc");
  });
});

describe("type metadata rendering", () => {
  const files = generatePhp({ namespace: "App\\Skir", modules, adapter: new MinimalAdapter() });
  const codeFor = (path: string): string => files.find((file) => file.path === path)?.code ?? "";

  it("passes the normalized record id to struct renderers", () => {
    expect(codeFor("Identity/Invitation.php")).toBe("struct identity/identity.skir:Invitation\n");
  });

  it("renders the record id and docs on a nested enum", () => {
    const code = codeFor("Identity/InvitationStatus.php");

    expect(code).toContain([
      "        return Type::enum([",
      "        Variant::constant('pending', 1),",
      "        Variant::constant('accepted', 2, doc: 'The invitee joined.'),",
      "        Variant::wrapper('declined', 3, Type::string(), doc: 'Carries the reason.'),",
      "        Variant::wrapper('expired_at', 4, Type::timestamp()),",
      `        ], recordId: 'identity/identity.skir:Invitation.Status', doc: ${phpSingleQuotedLiteral(TRICKY_DOC)});`,
    ].join("\n"));
  });

  it("renders the record id without a doc argument on an undocumented enum", () => {
    const code = codeFor("Identity/Client.php");

    expect(code).toContain([
      "        return Type::enum([",
      "        Variant::constant('tablet', 1),",
      "        ], recordId: 'identity/identity.skir:Client');",
    ].join("\n"));
    expect(code).not.toContain("doc:");
  });

  it("renders method docs only for documented methods", () => {
    const code = codeFor("Identity/SkirMethods.php");

    expect(code).toContain([
      "        return new MethodDescriptor(",
      "            name: 'GetInvitation',",
      "            number: 10,",
      "            requestType: Type::string(),",
      "            responseType: Invitation::skirType(),",
      "            doc: 'Returns the invitation.',",
      "        );",
    ].join("\n"));
    expect(code).toContain([
      "            name: 'Ping',",
      "            number: 11,",
      "            requestType: Type::string(),",
      "            responseType: Type::string(),",
      "        );",
    ].join("\n"));
    expect(code).toContain(`            doc: ${phpSingleQuotedLiteral(TRICKY_DOC)},`);
    expect(code.match(/doc:/g)).toHaveLength(2);
  });
});

describe("PHP metadata argument helpers", () => {
  it("escapes quotes, backslashes, and line breaks into a one-line PHP expression", () => {
    const literal = phpSingleQuotedLiteral(TRICKY_DOC);

    expect(literal).toBe(
      "'It\\'s a \"quote\", a back\\\\slash'.\"\\n\".'and a second line.\\\\'",
    );
    expect(literal).not.toContain("\n");
    expect(evaluatePhpExpression(literal)).toBe(TRICKY_DOC);
  });

  it("round-trips carriage returns, dollar signs, and empty text through PHP", () => {
    for (const text of ["", "a\r\nb", "$name {$x} \\n", "\n", "trailing\n"]) {
      expect(evaluatePhpExpression(phpSingleQuotedLiteral(text))).toBe(text);
    }
  });

  it("renders the doc argument only for non-blank docs", () => {
    expect(renderDocArgument(undefined)).toBe("");
    expect(renderDocArgument("")).toBe("");
    expect(renderDocArgument(" \n\t")).toBe("");
    expect(renderDocArgument("The phone app.")).toBe(", doc: 'The phone app.'");
  });

  it("always renders the record id and appends the doc when present", () => {
    expect(renderRecordMetadataArguments({ recordId: "a/b.skir:Outer.Inner" }))
      .toBe(", recordId: 'a/b.skir:Outer.Inner'");
    expect(renderRecordMetadataArguments({ recordId: "a/b.skir:Outer", doc: "It's documented." }))
      .toBe(", recordId: 'a/b.skir:Outer', doc: 'It\\'s documented.'");
  });
});
