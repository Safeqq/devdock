import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

export const cyclonedxSchema = "http://cyclonedx.org/schema/bom-1.5.schema.json";
export const sbomEvidenceSchemaVersion = 2;

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

function packageNameFromLockPath(path) {
  const marker = "node_modules/";
  const markerIndex = path.lastIndexOf(marker);
  requireCondition(markerIndex >= 0, `Package lock path is not installed: ${path}`);
  const segments = path.slice(markerIndex + marker.length).split("/");
  const expectedSegments = segments[0]?.startsWith("@") ? 2 : 1;
  requireCondition(
    segments.length === expectedSegments && segments.every((segment) => segment.length > 0),
    `Package lock path is invalid: ${path}`,
  );
  return segments.join("/");
}

function sha512FromIntegrity(integrity, reference) {
  requireCondition(
    typeof integrity === "string" && integrity.trim().length > 0,
    `Package lock component ${reference} has no integrity`,
  );
  const sha512Tokens = integrity
    .trim()
    .split(/\s+/u)
    .filter((token) => token.startsWith("sha512-"));
  requireCondition(
    sha512Tokens.length === 1,
    `Package lock component ${reference} must have one SHA-512 integrity`,
  );
  const encoded = sha512Tokens[0].slice("sha512-".length);
  const digest = Buffer.from(encoded, "base64");
  const canonical = digest.toString("base64").replace(/=+$/u, "");
  requireCondition(
    digest.byteLength === 64 && canonical === encoded.replace(/=+$/u, ""),
    `Package lock component ${reference} has invalid SHA-512 integrity`,
  );
  return digest.toString("hex");
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

export function packageNameFromReference(reference) {
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

export function validateCycloneDxLockfileProvenance(document, lockfile) {
  requireCondition(Array.isArray(document?.components), "CycloneDX components are missing");
  requireCondition(lockfile?.lockfileVersion === 3, "Package lock version must be 3");
  requireCondition(
    lockfile.packages !== null && typeof lockfile.packages === "object",
    "Package lock inventory is missing",
  );

  const expected = new Map();
  let linkedComponentCount = 0;
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (!path.includes("node_modules/") || entry?.dev === true) continue;
    let name;
    let version;
    let resolved = null;
    let sha512 = null;
    if (entry?.link === true) {
      requireCondition(
        typeof entry.resolved === "string" && entry.resolved.length > 0,
        `Linked package ${path} has no target`,
      );
      const target = lockfile.packages[entry.resolved];
      requireCondition(
        typeof target?.name === "string" && target.name.length > 0,
        `Linked package target ${entry.resolved} has no name`,
      );
      requireCondition(
        typeof target.version === "string" && target.version.length > 0,
        `Linked package target ${entry.resolved} has no version`,
      );
      name = target.name;
      version = target.version;
      requireCondition(
        packageNameFromLockPath(path) === name,
        `Linked package path ${path} does not match ${name}`,
      );
      linkedComponentCount += 1;
    } else {
      name = packageNameFromLockPath(path);
      requireCondition(
        typeof entry?.version === "string" && entry.version.length > 0,
        `Package lock component ${name} has no version`,
      );
      requireCondition(
        typeof entry.resolved === "string" && entry.resolved.length > 0,
        `Package lock component ${name}@${entry.version} has no resolved source`,
      );
      version = entry.version;
      resolved = entry.resolved;
      sha512 = sha512FromIntegrity(entry.integrity, `${name}@${version}`);
    }
    const reference = `${name}@${version}`;
    requireCondition(
      !expected.has(reference),
      `Package lock contains duplicate production component ${reference}`,
    );
    expected.set(reference, { name, version, resolved, sha512 });
  }

  requireCondition(
    expected.size === document.components.length,
    `CycloneDX has ${document.components.length} components but the production lockfile has ${expected.size}`,
  );
  const actual = new Map(
    document.components.map((component) => [component?.["bom-ref"], component]),
  );
  requireCondition(
    actual.size === document.components.length,
    "CycloneDX component references are not unique",
  );

  let integrityVerifiedComponentCount = 0;
  let distributionVerifiedComponentCount = 0;
  for (const [reference, locked] of expected) {
    const component = actual.get(reference);
    requireCondition(
      component !== undefined,
      `CycloneDX is missing production lockfile component ${reference}`,
    );
    requireCondition(
      component.version === locked.version,
      `CycloneDX component ${reference} has a stale version`,
    );
    requireCondition(
      component.purl === npmPurl(locked.name, locked.version),
      `CycloneDX component ${reference} has a stale package URL`,
    );
    if (locked.sha512 === null) continue;
    const hashes = Array.isArray(component.hashes)
      ? component.hashes.filter(
          (hash) =>
            typeof hash?.alg === "string" &&
            hash.alg.replaceAll("-", "").toUpperCase() === "SHA512",
        )
      : [];
    requireCondition(
      hashes.length === 1 &&
        typeof hashes[0].content === "string" &&
        hashes[0].content.toLowerCase() === locked.sha512,
      `CycloneDX component ${reference} does not match lockfile SHA-512 integrity`,
    );
    integrityVerifiedComponentCount += 1;
    const distributions = Array.isArray(component.externalReferences)
      ? component.externalReferences.filter((reference_) => reference_?.type === "distribution")
      : [];
    requireCondition(
      distributions.length === 1 && distributions[0].url === locked.resolved,
      `CycloneDX component ${reference} does not match its lockfile distribution`,
    );
    distributionVerifiedComponentCount += 1;
  }
  for (const reference of actual.keys()) {
    requireCondition(
      expected.has(reference),
      `CycloneDX includes component ${String(reference)} that is absent from the production lockfile`,
    );
  }

  return {
    lockfileComponentCount: expected.size,
    linkedComponentCount,
    integrityVerifiedComponentCount,
    distributionVerifiedComponentCount,
  };
}

export function sbomFilename(packageFilename) {
  requireCondition(packageFilename.endsWith(".tgz"), "Package evidence filename is invalid");
  return `${packageFilename.slice(0, -4)}.cdx.json`;
}
