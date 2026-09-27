import { z } from "zod";

const identifier = z.string().min(1).max(128);
const timeoutMs = z.number().int().positive().max(60_000);

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
    scriptName: z.string().min(1).max(128),
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
