import { packageNameFromReference, requireCondition } from "./sbom-utils.mjs";

export const licenseInventorySchemaVersion = 1;
export const licenseEvidenceSchemaVersion = 1;

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function licenseDeclarations(component) {
  if (!Array.isArray(component.licenses)) return [];
  const declarations = new Map();
  for (const entry of component.licenses) {
    let declaration;
    if (isNonEmptyString(entry?.expression)) {
      declaration = { type: "expression", value: entry.expression.trim() };
    } else if (isNonEmptyString(entry?.license?.id)) {
      declaration = { type: "id", value: entry.license.id.trim() };
    } else if (isNonEmptyString(entry?.license?.name)) {
      declaration = { type: "name", value: entry.license.name.trim() };
    }
    if (declaration !== undefined) {
      declarations.set(`${declaration.type}:${declaration.value}`, declaration);
    }
  }
  return [...declarations.values()].sort((left, right) =>
    compareText(`${left.type}:${left.value}`, `${right.type}:${right.value}`),
  );
}

function componentRecord(component) {
  const reference = component?.["bom-ref"];
  requireCondition(typeof reference === "string", "License component reference is invalid");
  requireCondition(isNonEmptyString(component.version), `Component ${reference} has no version`);
  requireCondition(isNonEmptyString(component.purl), `Component ${reference} has no package URL`);
  return {
    name: packageNameFromReference(reference),
    version: component.version.trim(),
    reference,
    purl: component.purl.trim(),
    licenses: licenseDeclarations(component),
  };
}

export function internalPackageNamesFromLockfile(lockfile) {
  requireCondition(
    lockfile?.packages !== null && typeof lockfile?.packages === "object",
    "Package lock workspace inventory is missing",
  );
  const names = new Set();
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (entry?.link !== true) continue;
    requireCondition(
      typeof entry.resolved === "string" && entry.resolved.length > 0,
      `Linked package ${path} has no target`,
    );
    const target = lockfile.packages[entry.resolved];
    requireCondition(
      isNonEmptyString(target?.name),
      `Linked package target ${entry.resolved} has no package name`,
    );
    requireCondition(
      path === `node_modules/${target.name}`,
      `Linked package ${path} does not match ${target.name}`,
    );
    names.add(target.name);
  }
  return [...names].sort(compareText);
}

export function createLicenseInventory(document, manifest, internalPackageNames) {
  requireCondition(Array.isArray(document?.components), "CycloneDX components are missing");
  requireCondition(Array.isArray(internalPackageNames), "Internal package names are missing");
  const internalNames = new Set(internalPackageNames);
  requireCondition(
    internalNames.size === internalPackageNames.length,
    "Internal package names contain duplicates",
  );

  const internal = [];
  const thirdParty = [];
  for (const component of document.components) {
    const record = componentRecord(component);
    if (internalNames.has(record.name)) {
      internal.push(record);
      continue;
    }
    requireCondition(
      record.licenses.length > 0,
      `Third-party component ${record.reference} has no license metadata`,
    );
    thirdParty.push(record);
  }
  internal.sort((left, right) => compareText(left.reference, right.reference));
  thirdParty.sort((left, right) => compareText(left.reference, right.reference));

  const discoveredInternalNames = new Set(internal.map((component) => component.name));
  for (const name of internalNames) {
    requireCondition(
      discoveredInternalNames.has(name),
      `Internal package ${name} is missing from the CycloneDX inventory`,
    );
  }

  const declarations = new Map();
  for (const component of thirdParty) {
    for (const declaration of component.licenses) {
      declarations.set(`${declaration.type}:${declaration.value}`, declaration);
    }
  }
  const licenseDeclarations = [...declarations.values()].sort((left, right) =>
    compareText(`${left.type}:${left.value}`, `${right.type}:${right.value}`),
  );
  const declaredProjectLicense = isNonEmptyString(manifest.license)
    ? manifest.license.trim()
    : null;
  const projectLicenseSelected =
    declaredProjectLicense !== null && declaredProjectLicense !== "UNLICENSED";

  return {
    schemaVersion: licenseInventorySchemaVersion,
    source: {
      format: document.bomFormat,
      specVersion: document.specVersion,
      serialNumber: document.serialNumber,
    },
    project: {
      name: manifest.name,
      version: manifest.version,
      declaredLicense: projectLicenseSelected ? declaredProjectLicense : null,
      licenseSelected: projectLicenseSelected,
    },
    summary: {
      thirdPartyComponentCount: thirdParty.length,
      uniqueThirdPartyPackageCount: new Set(thirdParty.map((component) => component.name)).size,
      internalComponentCount: internal.length,
      uniqueLicenseDeclarationCount: licenseDeclarations.length,
      missingThirdPartyLicenseMetadataCount: 0,
    },
    licenseDeclarations,
    thirdParty,
    internal,
  };
}

export function licenseInventoryFilename(packageFilename) {
  requireCondition(packageFilename.endsWith(".tgz"), "Package evidence filename is invalid");
  return `${packageFilename.slice(0, -4)}.licenses.json`;
}
