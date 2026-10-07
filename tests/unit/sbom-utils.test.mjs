import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeCycloneDx,
  validateCycloneDx,
  validateCycloneDxLockfileProvenance,
} from "../../scripts/sbom-utils.mjs";

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

test("CycloneDX versions, integrity, and distributions match the production lockfile", () => {
  const source = fixtureDocument();
  const digest = Buffer.alloc(64, 0xab);
  const distribution = "https://registry.npmjs.org/dependency/-/dependency-4.5.6.tgz";
  source.components[0].hashes = [{ alg: "SHA-512", content: digest.toString("hex") }];
  source.components[0].externalReferences = [{ type: "distribution", url: distribution }];
  const document = normalizeCycloneDx(source, manifest);
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      "": { name: "devdock", version: "1.2.3" },
      "node_modules/dependency": {
        version: "4.5.6",
        resolved: distribution,
        integrity: `sha512-${digest.toString("base64")}`,
      },
    },
  };
  assert.deepEqual(validateCycloneDxLockfileProvenance(document, lockfile), {
    lockfileComponentCount: 1,
    linkedComponentCount: 0,
    integrityVerifiedComponentCount: 1,
    distributionVerifiedComponentCount: 1,
  });

  const changedHash = structuredClone(document);
  changedHash.components[0].hashes[0].content = "00".repeat(64);
  assert.throws(
    () => validateCycloneDxLockfileProvenance(changedHash, lockfile),
    /does not match lockfile SHA-512 integrity/u,
  );

  const changedDistribution = structuredClone(document);
  changedDistribution.components[0].externalReferences[0].url =
    "https://registry.npmjs.org/dependency/-/dependency-4.5.5.tgz";
  assert.throws(
    () => validateCycloneDxLockfileProvenance(changedDistribution, lockfile),
    /does not match its lockfile distribution/u,
  );

  const changedVersion = structuredClone(lockfile);
  changedVersion.packages["node_modules/dependency"].version = "4.5.7";
  assert.throws(
    () => validateCycloneDxLockfileProvenance(document, changedVersion),
    /missing production lockfile component dependency@4\.5\.7/u,
  );
});
