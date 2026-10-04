import { z } from "zod";

const identifier = z.string().min(1).max(128);
const timeoutMs = z.number().int().positive().max(60_000);
const httpReadinessPath = z
  .string()
  .startsWith("/")
  .max(2_048)
  .refine((path) => !path.startsWith("//"), "Readiness paths cannot contain an authority")
  .refine(
    (path) =>
      ![...path].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
      }),
    "Readiness paths cannot contain control characters",
  )
  .refine((path) => !path.includes("#"), "Readiness paths cannot contain fragments");

export const EnvironmentKeyNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "Environment key names must be portable identifiers");

export const EnvironmentFileReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
      }),
    "Environment file references cannot contain control characters",
  );

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const EnvironmentFileReferencesSchema = z
  .array(EnvironmentFileReferenceSchema)
  .max(8)
  .refine(uniqueStrings, "Environment file references must be unique");

const RequiredEnvironmentKeysSchema = z
  .array(EnvironmentKeyNameSchema)
  .max(64)
  .refine(uniqueStrings, "Required environment keys must be unique");

export const NpmScriptNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (name) =>
      [...name].every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
      }),
    "Script names cannot contain control characters",
  )
  .refine((name) => !name.startsWith("-"), "Script names cannot start with '-'");

export const ProcessStateSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "exited",
  "failed",
]);
export type ProcessState = z.infer<typeof ProcessStateSchema>;

export const ReadinessStateSchema = z.enum(["unknown", "checking", "ready", "unhealthy"]);
export type ReadinessState = z.infer<typeof ReadinessStateSchema>;

export const ReconciliationStateSchema = z.enum(["known", "unknown"]);
export type ReconciliationState = z.infer<typeof ReconciliationStateSchema>;

export const ReadinessProbeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("tcp"), timeoutMs }),
  z.strictObject({
    kind: z.literal("http"),
    path: httpReadinessPath,
    timeoutMs,
  }),
]);
export type ReadinessProbe = z.infer<typeof ReadinessProbeSchema>;

export const RestartPolicySchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("off") }),
    z.strictObject({
      kind: z.literal("on_failure"),
      maxAttempts: z.number().int().min(1).max(10),
      initialBackoffMs: z.number().int().min(100).max(60_000),
      maxBackoffMs: z.number().int().min(100).max(300_000),
    }),
  ])
  .refine((policy) => policy.kind === "off" || policy.maxBackoffMs >= policy.initialBackoffMs, {
    message: "Maximum restart backoff must be at least the initial backoff",
    path: ["maxBackoffMs"],
  });
export type RestartPolicy = z.infer<typeof RestartPolicySchema>;

export const ServiceConfigSchema = z
  .strictObject({
    id: identifier,
    projectId: identifier,
    displayName: z.string().trim().min(1).max(128),
    scriptName: NpmScriptNameSchema,
    cwd: z.strictObject({
      displayPath: z.string().min(1),
      canonicalPath: z.string().min(1),
    }),
    expectedPort: z.number().int().min(1).max(65_535).optional(),
    readiness: ReadinessProbeSchema.optional(),
    restartPolicy: RestartPolicySchema.default({ kind: "off" }),
    envFiles: EnvironmentFileReferencesSchema.default([]),
    requiredEnvKeys: RequiredEnvironmentKeysSchema.default([]),
  })
  .refine((service) => service.readiness === undefined || service.expectedPort !== undefined, {
    message: "expectedPort is required when readiness is configured",
    path: ["expectedPort"],
  });
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

export const ProfileServiceSchema = z.strictObject({
  serviceId: z.uuid(),
  dependsOn: z.array(z.uuid()).max(32).refine(uniqueStrings, "Profile dependencies must be unique"),
});
export type ProfileService = z.infer<typeof ProfileServiceSchema>;

const ProfileServicesSchema = z
  .array(ProfileServiceSchema)
  .min(1)
  .max(32)
  .refine(
    (services) => uniqueStrings(services.map((service) => service.serviceId)),
    "Profile services must be unique",
  )
  .superRefine((services, context) => {
    const members = new Set(services.map((service) => service.serviceId));
    for (const [index, service] of services.entries()) {
      for (const dependency of service.dependsOn) {
        if (dependency === service.serviceId) {
          context.addIssue({
            code: "custom",
            message: "A profile service cannot depend on itself",
            path: [index, "dependsOn"],
          });
        } else if (!members.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: "Profile dependencies must be members of the profile",
            path: [index, "dependsOn"],
          });
        }
      }
    }
  });

export const ProfileConfigSchema = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  displayName: z.string().trim().min(1).max(128),
  services: ProfileServicesSchema,
});
export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;

const RelativePathSegmentSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((segment) => segment !== "." && segment !== "..", "Path segments must be relative")
  .refine(
    (segment) =>
      [...segment].every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
      }),
    "Path segments cannot contain control characters",
  );

const ProjectConfigurationServiceSchema = z
  .strictObject({
    serviceRef: identifier,
    displayName: z.string().trim().min(1).max(128),
    scriptName: NpmScriptNameSchema,
    cwd: z.array(RelativePathSegmentSchema).max(128),
    expectedPort: z.number().int().min(1).max(65_535).optional(),
    readiness: ReadinessProbeSchema.optional(),
    restartPolicy: RestartPolicySchema,
    envFiles: EnvironmentFileReferencesSchema,
    requiredEnvKeys: RequiredEnvironmentKeysSchema,
  })
  .refine((service) => service.readiness === undefined || service.expectedPort !== undefined, {
    message: "expectedPort is required when readiness is exported",
    path: ["expectedPort"],
  });

const ProjectConfigurationProfileServiceSchema = z.strictObject({
  serviceRef: identifier,
  dependsOn: z.array(identifier).max(32).refine(uniqueStrings, "Dependencies must be unique"),
});

const ProjectConfigurationProfileSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(128),
  services: z.array(ProjectConfigurationProfileServiceSchema).min(1).max(32),
});

export const ProjectConfigurationExportSchema = z
  .strictObject({
    format: z.literal("devdock.project-configuration"),
    schemaVersion: z.literal(1),
    project: z.strictObject({ displayName: z.string().trim().min(1).max(128) }),
    services: z.array(ProjectConfigurationServiceSchema),
    profiles: z.array(ProjectConfigurationProfileSchema),
  })
  .superRefine((configuration, context) => {
    const serviceRefs = configuration.services.map((service) => service.serviceRef);
    if (!uniqueStrings(serviceRefs)) {
      context.addIssue({
        code: "custom",
        message: "Exported service references must be unique",
        path: ["services"],
      });
    }
    const available = new Set(serviceRefs);
    for (const [profileIndex, profile] of configuration.profiles.entries()) {
      const members = profile.services.map((service) => service.serviceRef);
      if (!uniqueStrings(members)) {
        context.addIssue({
          code: "custom",
          message: "Exported profile services must be unique",
          path: ["profiles", profileIndex, "services"],
        });
      }
      const memberSet = new Set(members);
      for (const [serviceIndex, service] of profile.services.entries()) {
        if (!available.has(service.serviceRef)) {
          context.addIssue({
            code: "custom",
            message: "Exported profile service must reference an exported service",
            path: ["profiles", profileIndex, "services", serviceIndex, "serviceRef"],
          });
        }
        for (const dependency of service.dependsOn) {
          if (!memberSet.has(dependency) || dependency === service.serviceRef) {
            context.addIssue({
              code: "custom",
              message: "Exported dependencies must reference another profile member",
              path: ["profiles", profileIndex, "services", serviceIndex, "dependsOn"],
            });
          }
        }
      }
    }
  });
export type ProjectConfigurationExport = z.infer<typeof ProjectConfigurationExportSchema>;

export const RunSnapshotSchema = z.strictObject({
  runId: identifier,
  serviceId: identifier,
  processState: ProcessStateSchema,
  readinessState: ReadinessStateSchema,
  reconciliationState: ReconciliationStateSchema,
  pid: z.number().int().positive().optional(),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).optional(),
  exitCode: z.number().int().nullable().optional(),
  failureReason: z.string().max(512).optional(),
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

export const LogEventSchema = z.strictObject({
  daemonSessionId: identifier,
  runId: identifier,
  sequence: z.number().int().positive().safe(),
  timestamp: z.iso.datetime({ offset: true }),
  type: z.literal("log"),
  stream: z.enum(["stdout", "stderr"]),
  text: z.string().max(16_384),
});
export type LogEvent = z.infer<typeof LogEventSchema>;

export const LogGapEventSchema = z.strictObject({
  daemonSessionId: identifier,
  runId: identifier,
  sequence: z.number().int().positive().safe(),
  timestamp: z.iso.datetime({ offset: true }),
  type: z.literal("gap"),
  oldestSequence: z.number().int().positive().safe(),
  latestSequence: z.number().int().nonnegative().safe(),
});
export type LogGapEvent = z.infer<typeof LogGapEventSchema>;

export const ProjectRecordSchema = z.strictObject({
  id: identifier,
  displayName: z.string().trim().min(1).max(128),
  path: z.strictObject({
    displayPath: z.string().min(1),
    canonicalPath: z.string().min(1),
  }),
  createdAt: z.iso.datetime({ offset: true }),
  archivedAt: z.iso.datetime({ offset: true }).optional(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const ScriptDiscoverySchema = z.strictObject({
  cwd: z.strictObject({
    displayPath: z.string().min(1),
    canonicalPath: z.string().min(1),
  }),
  packageName: z.string().max(214).optional(),
  scriptNames: z.array(NpmScriptNameSchema),
  unsupportedScriptCount: z.number().int().nonnegative(),
});
export type ScriptDiscovery = z.infer<typeof ScriptDiscoverySchema>;

export const AppSettingsSchema = z.strictObject({
  theme: z.enum(["system", "light", "dark"]).default("system"),
  logLineLimit: z.number().int().min(100).max(5_000).default(5_000),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const PairingRequestSchema = z.strictObject({
  code: z.string().min(1).max(128),
});

export const RegistryIdSchema = z.uuid();

export const RegisterProjectRequestSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  displayName: z.string().trim().min(1).max(128).optional(),
});

export const SelectServiceRequestSchema = z
  .strictObject({
    scriptName: NpmScriptNameSchema,
    cwd: z.string().min(1).max(4_096).optional(),
    displayName: z.string().trim().min(1).max(128).optional(),
    expectedPort: z.number().int().min(1).max(65_535).optional(),
    readiness: ReadinessProbeSchema.optional(),
    restartPolicy: RestartPolicySchema.default({ kind: "off" }),
    envFiles: EnvironmentFileReferencesSchema.default([]),
    requiredEnvKeys: RequiredEnvironmentKeysSchema.default([]),
  })
  .refine((service) => service.readiness === undefined || service.expectedPort !== undefined, {
    message: "expectedPort is required when readiness is configured",
    path: ["expectedPort"],
  });

export const CreateProfileRequestSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(128),
  services: ProfileServicesSchema,
});

export const SessionResponseSchema = z.strictObject({
  csrfToken: z.string().min(32),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const ProjectListResponseSchema = z.strictObject({ projects: z.array(ProjectRecordSchema) });
export const ProjectResponseSchema = z.strictObject({ project: ProjectRecordSchema });
export const ProjectDetailResponseSchema = z.strictObject({
  project: ProjectRecordSchema,
  services: z.array(ServiceConfigSchema),
  profiles: z.array(ProfileConfigSchema),
});
export const DiscoveryResponseSchema = z.strictObject({ discovery: ScriptDiscoverySchema });
export const ServiceResponseSchema = z.strictObject({ service: ServiceConfigSchema });
export const ProfileResponseSchema = z.strictObject({ profile: ProfileConfigSchema });
export const CommandPreviewResponseSchema = z.strictObject({
  command: z.strictObject({
    executable: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1),
  }),
});
export const OpenAppResponseSchema = z.strictObject({ url: z.url() });

export const PortDiagnosticSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_configured") }),
  z.strictObject({
    status: z.enum(["available", "in_use", "unknown"]),
    port: z.number().int().min(1).max(65_535),
  }),
]);
export type PortDiagnostic = z.infer<typeof PortDiagnosticSchema>;

export const EnvironmentFileDiagnosticSchema = z.strictObject({
  path: EnvironmentFileReferenceSchema,
  status: z.enum(["loaded", "missing", "unreadable", "invalid", "too_large", "outside_cwd"]),
});
export type EnvironmentFileDiagnostic = z.infer<typeof EnvironmentFileDiagnosticSchema>;

export const EnvironmentKeyDiagnosticSchema = z.strictObject({
  name: EnvironmentKeyNameSchema,
  present: z.boolean(),
});
export type EnvironmentKeyDiagnostic = z.infer<typeof EnvironmentKeyDiagnosticSchema>;

export const ServiceDiagnosticsResponseSchema = z.strictObject({
  port: PortDiagnosticSchema,
  environment: z.strictObject({
    files: z.array(EnvironmentFileDiagnosticSchema).max(8),
    keys: z.array(EnvironmentKeyDiagnosticSchema).max(64),
    allRequiredKeysPresent: z.boolean(),
  }),
});
export type ServiceDiagnosticsResponse = z.infer<typeof ServiceDiagnosticsResponseSchema>;

export const ServiceActionRequestSchema = z.strictObject({});

export const ServiceRuntimeStatusResponseSchema = z.strictObject({
  snapshot: RunSnapshotSchema.nullable(),
  ownership: z.enum(["owned", "exited", "unknown"]).nullable(),
});

const ServiceStartOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("started"), snapshot: RunSnapshotSchema }),
  z.strictObject({ kind: z.literal("existing"), snapshot: RunSnapshotSchema }),
  z.strictObject({
    kind: z.literal("failed"),
    snapshot: RunSnapshotSchema,
    reason: z.string().min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal("rejected"),
    snapshot: RunSnapshotSchema,
    reason: z.string().min(1).max(512),
  }),
]);

export const ServiceStartResponseSchema = z.strictObject({ outcome: ServiceStartOutcomeSchema });

const ServiceStopOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stopped"), snapshot: RunSnapshotSchema }),
  z.strictObject({
    kind: z.literal("already_stopped"),
    snapshot: RunSnapshotSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("incomplete"),
    snapshot: RunSnapshotSchema,
    reason: z.string().min(1).max(512),
  }),
]);

export const ServiceStopResponseSchema = z.strictObject({ outcome: ServiceStopOutcomeSchema });

export const ProfileOperationStateSchema = z.enum([
  "starting",
  "ready",
  "degraded",
  "stopping",
  "stopped",
]);
export type ProfileOperationState = z.infer<typeof ProfileOperationStateSchema>;

export const ProfileServiceOperationSchema = z.strictObject({
  serviceId: z.uuid(),
  origin: z.enum(["pending", "started", "pre_existing"]),
  state: z.enum(["pending", "starting", "ready", "failed", "rolled_back", "preserved", "stopped"]),
  runId: z.uuid().optional(),
  reason: z.string().min(1).max(512).optional(),
});
export type ProfileServiceOperation = z.infer<typeof ProfileServiceOperationSchema>;

export const ProfileOperationSnapshotSchema = z.strictObject({
  operationId: z.uuid(),
  profileId: z.uuid(),
  state: ProfileOperationStateSchema,
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).optional(),
  failureReason: z.string().min(1).max(512).optional(),
  services: z.array(ProfileServiceOperationSchema).min(1).max(32),
});
export type ProfileOperationSnapshot = z.infer<typeof ProfileOperationSnapshotSchema>;

export const ProfileRuntimeStatusResponseSchema = z.strictObject({
  snapshot: ProfileOperationSnapshotSchema.nullable(),
});

const ProfileStartOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("started"), snapshot: ProfileOperationSnapshotSchema }),
  z.strictObject({ kind: z.literal("existing"), snapshot: ProfileOperationSnapshotSchema }),
]);

export const ProfileStartResponseSchema = z.strictObject({ outcome: ProfileStartOutcomeSchema });

const ProfileStopOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stopped"), snapshot: ProfileOperationSnapshotSchema }),
  z.strictObject({
    kind: z.literal("already_stopped"),
    snapshot: ProfileOperationSnapshotSchema.nullable(),
  }),
]);

export const ProfileStopResponseSchema = z.strictObject({ outcome: ProfileStopOutcomeSchema });
