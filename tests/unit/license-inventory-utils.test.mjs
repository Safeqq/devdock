import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLicenseInventory,
  internalPackageNamesFromLockfile,
} from "../../scripts/license-inventory-utils.mjs";

function fixtureDocument() {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    components: [
      {
        "bom-ref": "zeta@2.0.0",
        version: "2.0.0",
        purl: "pkg:npm/zeta@2.0.0",
        licenses: [{ license: { id: "MIT" } }],
      },
      {
        "bom-ref": "@devdock/internal@1.2.3",
        version: "1.2.3",
        purl: "pkg:npm/%40devdock/internal@1.2.3",
      },
      {
        "bom-ref": "alpha@1.0.0",
        version: "1.0.0",
        purl: "pkg:npm/alpha@1.0.0",
        licenses: [{ expression: "Apache-2.0 OR MIT" }],
      },
    ],
  };
}

test("license inventory separates workspaces and requires third-party declarations", () => {
  const lockfile = {
    packages: {
      "node_modules/@devdock/internal": { resolved: "packages/internal", link: true },
      "packages/internal": { name: "@devdock/internal", version: "1.2.3" },
    },
  };
  const internalNames = internalPackageNamesFromLockfile(lockfile);
  assert.deepEqual(internalNames, ["@devdock/internal"]);

  const inventory = createLicenseInventory(
    fixtureDocument(),
    { name: "devdock", version: "1.2.3", private: true },
    internalNames,
  );
  assert.deepEqual(inventory.summary, {
    thirdPartyComponentCount: 2,
    uniqueThirdPartyPackageCount: 2,
    internalComponentCount: 1,
    uniqueLicenseDeclarationCount: 2,
    missingThirdPartyLicenseMetadataCount: 0,
  });
  assert.deepEqual(
    inventory.thirdParty.map((component) => component.name),
    ["alpha", "zeta"],
  );
  assert.deepEqual(
    inventory.internal.map((component) => component.name),
    ["@devdock/internal"],
  );
  assert.deepEqual(inventory.licenseDeclarations, [
    { type: "expression", value: "Apache-2.0 OR MIT" },
    { type: "id", value: "MIT" },
  ]);
  assert.deepEqual(inventory.project, {
    name: "devdock",
    version: "1.2.3",
    declaredLicense: null,
    licenseSelected: false,
  });

  const missing = fixtureDocument();
  delete missing.components[0].licenses;
  assert.throws(
    () => createLicenseInventory(missing, { name: "devdock", version: "1.2.3" }, internalNames),
    /Third-party component zeta@2\.0\.0 has no license metadata/u,
  );
});
