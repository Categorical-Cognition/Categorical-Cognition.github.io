export const CAPABILITY_PROFILE_FORMAT = "golog.capability-profile";
export const CAPABILITY_PROFILE_VERSION = 1;

export const CAPABILITY_PROFILE_DEFAULTS = Object.freeze({
  deviceClass: "unknown",
  renderClass: "unknown",
  memoryClass: "unknown",
  batteryState: "unknown",
  computeScore: 1,
  latencyMs: null,
  load: null,
  availability: "unknown",
});

const AVAILABILITY_WEIGHT = Object.freeze({
  available: 1,
  unknown: 0.75,
  busy: 0.45,
  constrained: 0.35,
  offline: 0,
});

const BATTERY_WEIGHT = Object.freeze({
  charging: 1,
  full: 1,
  unknown: 0.85,
  medium: 0.75,
  low: 0.45,
  critical: 0.15,
});

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeNullableNumber(value, { min = -Infinity, max = Infinity } = {}) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, min, max) : null;
}

export function normalizeCapabilityProfile(input = {}) {
  const source = input?.format === CAPABILITY_PROFILE_FORMAT ? input : input ?? {};
  return {
    format: CAPABILITY_PROFILE_FORMAT,
    version: CAPABILITY_PROFILE_VERSION,
    deviceClass: String(source.deviceClass ?? CAPABILITY_PROFILE_DEFAULTS.deviceClass),
    renderClass: String(source.renderClass ?? CAPABILITY_PROFILE_DEFAULTS.renderClass),
    memoryClass: String(source.memoryClass ?? CAPABILITY_PROFILE_DEFAULTS.memoryClass),
    batteryState: String(source.batteryState ?? CAPABILITY_PROFILE_DEFAULTS.batteryState),
    computeScore:
      normalizeNullableNumber(source.computeScore, { min: 0 }) ??
      CAPABILITY_PROFILE_DEFAULTS.computeScore,
    latencyMs: normalizeNullableNumber(source.latencyMs, { min: 0 }),
    load: normalizeNullableNumber(source.load, { min: 0, max: 1 }),
    availability: String(
      source.availability ?? CAPABILITY_PROFILE_DEFAULTS.availability,
    ),
  };
}

export function scoreCapabilityProfile(input = {}) {
  const profile = normalizeCapabilityProfile(input);
  const availability =
    AVAILABILITY_WEIGHT[profile.availability] ?? AVAILABILITY_WEIGHT.unknown;
  const battery = BATTERY_WEIGHT[profile.batteryState] ?? BATTERY_WEIGHT.unknown;
  const load = finiteNumber(profile.load) ? 1 - profile.load : 0.75;
  const latency = finiteNumber(profile.latencyMs)
    ? 1 / (1 + profile.latencyMs / 100)
    : 0.75;
  return Number(
    (profile.computeScore * availability * battery * load * latency).toFixed(4),
  );
}

export function compareCapabilityProfiles(first, second) {
  return scoreCapabilityProfile(second) - scoreCapabilityProfile(first);
}
