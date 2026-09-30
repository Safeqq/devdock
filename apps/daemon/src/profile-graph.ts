import type { ProfileConfig, ProfileService } from "@devdock/contracts";

export class ProfileGraphError extends Error {
  constructor(readonly cycle: readonly string[]) {
    super(`Profile dependency cycle: ${cycle.join(" -> ")}`);
    this.name = "ProfileGraphError";
  }
}

export function profileStartOrder(
  profile: Pick<ProfileConfig, "services"> | { readonly services: readonly ProfileService[] },
): string[] {
  const services = new Map(profile.services.map((service) => [service.serviceId, service]));
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const ordered: string[] = [];

  const visit = (serviceId: string): void => {
    const current = state.get(serviceId);
    if (current === "visited") return;
    if (current === "visiting") {
      const cycleStart = stack.indexOf(serviceId);
      const cycle = [...stack.slice(cycleStart), serviceId];
      throw new ProfileGraphError(cycle);
    }
    const service = services.get(serviceId);
    if (service === undefined) {
      throw new Error(`Profile dependency is not a member: ${serviceId}`);
    }
    state.set(serviceId, "visiting");
    stack.push(serviceId);
    for (const dependency of service.dependsOn) visit(dependency);
    stack.pop();
    state.set(serviceId, "visited");
    ordered.push(serviceId);
  };

  for (const service of profile.services) visit(service.serviceId);
  return ordered;
}
