import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCycloneDx, validateCycloneDx } from "../../scripts/sbom-utils.mjs";

function fixtureDocument() {
  return {
    $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    version: 1,
    metadata: {
      timestamp: "2030-02-03T00:00:00.000Z",
      component: {
        "bom-ref": "devdock@1.2.3",
        type: "application",
        name: "devdock",
        version: "1.2.3",
      },
    },
    components: [
      {
        "bom-ref": "dependency@4.5.6",
        type: "library",
        name: "dependency",
        version: "4.5.6",
        purl: "pkg:npm/dependency@4.5.6",
      },
    ],
    dependencies: [
      { ref: "devdock@1.2.3", dependsOn: ["dependency@4.5.6"] },
      { ref: "dependency@4.5.6", dependsOn: [] },
    ],
  };
}

const manifest = { name: "devdock", version: "1.2.3" };
const packageEvidence = { package: { bundled: ["dependency"] } };

test("CycloneDX normalization is deterministic and rejects unsafe inventory", () => {
  const first = normalizeCycloneDx(fixtureDocument(), manifest);
  const alternateCheckout = fixtureDocument();
  alternateCheckout.serialNumber = "urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  alternateCheckout.metadata.timestamp = "2040-04-05T00:00:00.000Z";
  alternateCheckout.metadata.component.name = "different checkout folder";
  alternateCheckout.metadata.component["bom-ref"] = "different checkout folder@1.2.3";
  alternateCheckout.metadata.component.purl = "pkg:npm/different%20checkout%20folder@1.2.3";
  alternateCheckout.dependencies[0].ref = "different checkout folder@1.2.3";
  const second = normalizeCycloneDx(alternateCheckout, manifest);
  assert.deepEqual(first, second);
  assert.equal("timestamp" in first.metadata, false);
  assert.match(first.serialNumber, /^urn:uuid:/u);
  assert.deepEqual(validateCycloneDx(first, manifest, packageEvidence), {
    componentCount: 1,
    dependencyCount: 2,
    uniquePackageCount: 1,
  });

  const development = structuredClone(first);
  development.components[0].properties = [{ name: "cdx:npm:package:development", value: "true" }];
  assert.throws(
    () => validateCycloneDx(development, manifest, packageEvidence),
    /includes development component/u,
  );

  const absolutePath = structuredClone(first);
  absolutePath.components[0].properties = [
    { name: "cdx:npm:package:path", value: "C:\\Users\\secret\\dependency" },
  ];
  assert.throws(
    () => validateCycloneDx(absolutePath, manifest, packageEvidence),
    /absolute filesystem path/u,
  );

  const credentials = structuredClone(first);
  credentials.components[0].externalReferences = [
    { type: "distribution", url: "https://user:secret@example.invalid/dependency.tgz" },
  ];
  assert.throws(
    () => validateCycloneDx(credentials, manifest, packageEvidence),
    /URL credentials/u,
  );

  const sensitiveQuery = structuredClone(first);
  sensitiveQuery.components[0].externalReferences = [
    { type: "distribution", url: "https://example.invalid/dependency.tgz?access_token=secret" },
  ];
  assert.throws(
    () => validateCycloneDx(sensitiveQuery, manifest, packageEvidence),
    /sensitive URL query parameter/u,
  );
});
