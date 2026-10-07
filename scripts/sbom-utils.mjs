import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

export const cyclonedxSchema = "http://cyclonedx.org/schema/bom-1.5.schema.json";
export const sbomEvidenceSchemaVersion = 1;

export function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => canonicalize(item))
      .sort((left, right) => {
        const leftText = JSON.stringify(left);
        const rightText = JSON.stringify(right);
        if (leftText < rightText) return -1;
        if (leftText > rightText) return 1;
        return 0;
      });
  }
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

function uuidV5(name) {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const bytes = createHash("sha1").update(namespace).update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function npmPurl(name, version) {
  if (!name.startsWith("@"))
    return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
  const slash = name.indexOf("/");
  requireCondition(slash > 1, `Invalid scoped npm package name ${name}`);
  return `pkg:npm/${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}@${encodeURIComponent(version)}`;
}

export function normalizeCycloneDx(document, manifest) {
  const normalized = structuredClone(document);
  const rootComponent = normalized.metadata?.component;
  requireCondition(rootComponent !== undefined, "CycloneDX root component is missing");
  const oldRootReference = rootComponent["bom-ref"];
  const rootReference = `${manifest.name}@${manifest.version}`;
  rootComponent.name = manifest.name;
  rootComponent.version = manifest.version;
  rootComponent["bom-ref"] = rootReference;
  rootComponent.purl = npmPurl(manifest.name, manifest.version);
  if (Array.isArray(normalized.dependencies)) {
    for (const dependency of normalized.dependencies) {
      if (dependency.ref === oldRootReference) dependency.ref = rootReference;
      if (Array.isArray(dependency.dependsOn)) {
        dependency.dependsOn = dependency.dependsOn.map((reference) =>
          reference === oldRootReference ? rootReference : reference,
        );
      }
    }
  }
  delete normalized.serialNumber;
  if (normalized.metadata !== null && typeof normalized.metadata === "object") {
    delete normalized.metadata.timestamp;
  }
  const semantic = canonicalize(normalized);
  const serialNumber = `urn:uuid:${uuidV5(JSON.stringify(semantic))}`;
  return canonicalize({ ...semantic, serialNumber });
}

function packageNameFromReference(reference) {
  const versionSeparator = reference.lastIndexOf("@");
  requireCondition(versionSeparator > 0, `CycloneDX component has invalid reference ${reference}`);
  return reference.slice(0, versionSeparator);
}

function collectStrings(value, strings) {
  if (typeof value === "string") {
    strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, strings);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, strings);
  }
}

function assertSafeStrings(document, forbiddenPaths) {
  const strings = [];
  collectStrings(document, strings);
  const pathFragments = forbiddenPaths.flatMap((path) => [path, path.replaceAll("\\", "/")]);
  for (const value of strings) {
    requireCondition(
      !win32.isAbsolute(value) && !posix.isAbsolute(value),
      "CycloneDX document contains an absolute filesystem path",
    );
    requireCondition(
      pathFragments.every((fragment) => fragment.length === 0 || !value.includes(fragment)),
      "CycloneDX document contains a local filesystem path",
    );
    const webUrl = /^(?:git\+)?(https?:\/\/.*)$/iu.exec(value)?.[1];
    if (webUrl === undefined) continue;
    const parsed = new URL(webUrl);
    requireCondition(
      parsed.username.length === 0 && parsed.password.length === 0,
      "CycloneDX document contains URL credentials",
    );
    for (const key of parsed.searchParams.keys()) {
      requireCondition(
        !/(?:token|auth|password|passwd|secret|api[-_]?key)/iu.test(key),
        "CycloneDX document contains a sensitive URL query parameter",
      );
    }
  }
}

function hasDevelopmentMarker(component) {
  if (!Array.isArray(component.properties)) return false;
  return component.properties.some(
    (property) => property?.name === "cdx:npm:package:development" && property.value === "true",
  );
}

export function validateCycloneDx(document, manifest, packageEvidence, forbiddenPaths = []) {
  requireCondition(
    document !== null && typeof document === "object",
    "CycloneDX output is invalid",
  );
  requireCondition(document.$schema === cyclonedxSchema, "CycloneDX schema is not supported");
  requireCondition(document.bomFormat === "CycloneDX", "SBOM format must be CycloneDX");
  requireCondition(document.specVersion === "1.5", "CycloneDX version must be 1.5");
  requireCondition(document.version === 1, "CycloneDX document version must be 1");
  requireCondition(
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      document.serialNumber,
    ),
    "CycloneDX serial number is invalid",
  );
  const rootComponent = document.metadata?.component;
  requireCondition(
    rootComponent?.name === manifest.name,
    `CycloneDX root name must be ${manifest.name}, found ${String(rootComponent?.name)}`,
  );
  requireCondition(
    rootComponent?.version === manifest.version,
    `CycloneDX root version must be ${manifest.version}, found ${String(rootComponent?.version)}`,
  );
  requireCondition(rootComponent?.type === "application", "CycloneDX root must be an application");
  requireCondition(Array.isArray(document.components), "CycloneDX components are missing");
  requireCondition(Array.isArray(document.dependencies), "CycloneDX dependencies are missing");

  const componentReferences = new Set();
  const componentNames = new Set();
  for (const component of document.components) {
    const reference = component?.["bom-ref"];
    requireCondition(typeof reference === "string", "CycloneDX component reference is invalid");
    requireCondition(
      !componentReferences.has(reference),
      `Duplicate CycloneDX component ${reference}`,
    );
    requireCondition(
      !hasDevelopmentMarker(component),
      `CycloneDX includes development component ${reference}`,
    );
    componentReferences.add(reference);
    componentNames.add(packageNameFromReference(reference));
  }

  const expectedNames = [...packageEvidence.package.bundled].sort();
  const actualNames = [...componentNames].sort();
  requireCondition(
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    "CycloneDX production inventory does not match bundled package evidence",
  );

  const rootReference = rootComponent?.["bom-ref"];
  requireCondition(typeof rootReference === "string", "CycloneDX root reference is invalid");
  const knownReferences = new Set([rootReference, ...componentReferences]);
  const dependencyReferences = new Set();
  for (const dependency of document.dependencies) {
    requireCondition(
      typeof dependency?.ref === "string" && knownReferences.has(dependency.ref),
      "CycloneDX dependency references an unknown component",
    );
    requireCondition(
      !dependencyReferences.has(dependency.ref),
      `Duplicate CycloneDX dependency ${String(dependency.ref)}`,
    );
    requireCondition(Array.isArray(dependency.dependsOn), "CycloneDX dependency edges are invalid");
    for (const reference of dependency.dependsOn) {
      requireCondition(
        typeof reference === "string" && knownReferences.has(reference),
        "CycloneDX dependency edge references an unknown component",
      );
    }
    dependencyReferences.add(dependency.ref);
  }
  requireCondition(
    dependencyReferences.size === knownReferences.size,
    "CycloneDX dependency graph is incomplete",
  );
  assertSafeStrings(document, forbiddenPaths);
  return {
    componentCount: document.components.length,
    dependencyCount: document.dependencies.length,
    uniquePackageCount: componentNames.size,
  };
}

export function sbomFilename(packageFilename) {
  requireCondition(packageFilename.endsWith(".tgz"), "Package evidence filename is invalid");
  return `${packageFilename.slice(0, -4)}.cdx.json`;
}
