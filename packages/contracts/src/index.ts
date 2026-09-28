import { z } from "zod";

const identifier = z.string().min(1).max(128);
const timeoutMs = z.number().int().positive().max(60_000);

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
    readiness: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("tcp"), timeoutMs }),
        z.strictObject({
          kind: z.literal("http"),
          path: z.string().startsWith("/").max(2_048),
          timeoutMs,
        }),
      ])
      .optional(),
    envFiles: z.array(z.string().min(1)).default([]),
  })
  .refine((service) => service.readiness === undefined || service.expectedPort !== undefined, {
    message: "expectedPort is required when readiness is configured",
    path: ["expectedPort"],
  });
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

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

export const SelectServiceRequestSchema = z.strictObject({
  scriptName: NpmScriptNameSchema,
  cwd: z.string().min(1).max(4_096).optional(),
  displayName: z.string().trim().min(1).max(128).optional(),
  expectedPort: z.number().int().min(1).max(65_535).optional(),
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
});
export const DiscoveryResponseSchema = z.strictObject({ discovery: ScriptDiscoverySchema });
export const ServiceResponseSchema = z.strictObject({ service: ServiceConfigSchema });
export const CommandPreviewResponseSchema = z.strictObject({
  command: z.strictObject({
    executable: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1),
  }),
});
export const OpenAppResponseSchema = z.strictObject({ url: z.url() });
