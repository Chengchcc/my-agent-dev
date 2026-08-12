import { describe, expect, test } from "bun:test";
import { parseCatalogYAML } from "./model-catalog.js";

// parseCatalogYAML returns a loosely-typed structure; cast provider maps for
// assertions on keys beyond the strict ProviderSpec/ModelSpec contracts.
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v as Obj;

describe("parseCatalogYAML", () => {
  test("quoted scalars lose their surrounding quotes", () => {
    const cat = parseCatalogYAML(`providers:
  acme:
    api: openai
    baseUrl: "https://api.acme.test"
    apiKeyEnv: 'ACME_KEY'
    models:
      - id: gpt-x
        name: "GPT X-tra"
`);
    const acme = obj(cat.providers.acme);
    expect(acme.baseUrl).toBe("https://api.acme.test");
    expect(acme.apiKeyEnv).toBe("ACME_KEY");
    const model = obj((acme.models as unknown[])[0]);
    expect(model.name).toBe("GPT X-tra");
  });

  test('the literal "null" parses to JavaScript null (not empty string)', () => {
    const cat = parseCatalogYAML(`providers:
  acme:
    api: openai
    baseUrl: x
    apiKeyEnv: K
    models:
      - id: gpt-x
        name: GPT X
        deprecated: null
`);
    const model = obj((obj(cat.providers.acme).models as unknown[])[0]);
    expect(model.deprecated).toBeNull();
  });

  test("trailing ` # comment` is stripped from scalar values", () => {
    const cat = parseCatalogYAML(`providers:
  acme:
    api: openai # the api kind
    baseUrl: https://api.acme.test
    apiKeyEnv: KEY
    models:
      - id: gpt-x
        name: GPT X
`);
    expect(obj(cat.providers.acme).api).toBe("openai");
  });

  test("a `#` not preceded by whitespace is kept (URL fragment / no-space)", () => {
    const cat = parseCatalogYAML(`providers:
  acme:
    api: openai
    baseUrl: https://api.acme.test/#anchor
    apiKeyEnv: KEY
    models:
      - id: gpt-x
        name: GPT X
`);
    expect(obj(cat.providers.acme).baseUrl).toBe("https://api.acme.test/#anchor");
  });

  test("a `#` inside quotes is not treated as a comment", () => {
    const cat = parseCatalogYAML(`providers:
  acme:
    api: openai
    baseUrl: x
    apiKeyEnv: "K # not a comment"
    models:
      - id: gpt-x
        name: GPT X
`);
    expect(obj(cat.providers.acme).apiKeyEnv).toBe("K # not a comment");
  });

  test("missing top-level `providers` key throws a clear error", () => {
    expect(() => parseCatalogYAML(`foo: bar\nbaz: qux\n`)).toThrow(
      "models.yml: missing 'providers' key",
    );
  });

  test("empty `providers:` map is structurally valid (key present, not missing)", () => {
    const cat = parseCatalogYAML(`providers:\n`);
    expect(cat.providers).toEqual({});
  });
});
