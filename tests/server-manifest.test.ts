import { describe, expect, it } from "vitest";

import {
  generateServerManifestFile,
  SERVER_MANIFEST_VERSION,
} from "../src/index.js";

describe("generateServerManifestFile", () => {
  it("renders the established schema, root identity, module path, and trailing newline exactly", () => {
    expect(SERVER_MANIFEST_VERSION).toBe(1);
    expect(generateServerManifestFile("neutral-adapter", [
      {
        name: "_Root",
        methodEnum: "Neutral\\SkirMethod",
        methods: [{
          name: "CheckHealth",
          enumCase: "CheckHealth",
          phpMethod: "checkHealth",
          requestType: "string",
          requestClass: null,
          responseType: "?Neutral\\HealthObject",
          responseClass: "Neutral\\HealthObject",
        }],
      },
      {
        name: "Admin.Users",
        methodEnum: "Neutral\\Admin\\Users\\AdminUsersSkirMethod",
        methods: [],
      },
    ])).toEqual({
      path: "skir-server-manifest.json",
      code: [
        "{",
        "  \"version\": 1,",
        "  \"generator\": \"neutral-adapter\",",
        "  \"modules\": [",
        "    {",
        "      \"name\": \"_Root\",",
        "      \"methodEnum\": \"Neutral\\\\SkirMethod\",",
        "      \"methods\": [",
        "        {",
        "          \"name\": \"CheckHealth\",",
        "          \"enumCase\": \"CheckHealth\",",
        "          \"phpMethod\": \"checkHealth\",",
        "          \"requestType\": \"string\",",
        "          \"requestClass\": null,",
        "          \"responseType\": \"?Neutral\\\\HealthObject\",",
        "          \"responseClass\": \"Neutral\\\\HealthObject\"",
        "        }",
        "      ]",
        "    },",
        "    {",
        "      \"name\": \"Admin.Users\",",
        "      \"methodEnum\": \"Neutral\\\\Admin\\\\Users\\\\AdminUsersSkirMethod\",",
        "      \"methods\": []",
        "    }",
        "  ]",
        "}",
        "",
      ].join("\n"),
    });
  });
});
