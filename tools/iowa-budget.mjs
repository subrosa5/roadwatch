// Reproducible planning arithmetic; not a model throughput benchmark.
export function iowaBudget({
  days = 31,
  fps = 0.2,
  cpuMs = 50,
  eventsPerDay = 5,
  clipSeconds = 30,
  retentionDays = 7,
} = {}) {
  const bitrates = [133995, 262011]; // AVERAGE-BANDWIDTH, observed HLS master playlists.
  const bitsPerSecond = bitrates.reduce((a, b) => a + b, 0);
  const bytesPerSecond = bitsPerSecond / 8;
  const framesPerDay = bitrates.length * fps * 86400;
  return {
    assumptions: {
      days,
      fps,
      cpuMs,
      eventsPerDay,
      clipSeconds,
      retentionDays,
      bitrates,
      modelBenchmarked: false,
    },
    cameraCount: bitrates.length,
    videoGBPerDay: (bytesPerSecond * 86400) / 1e9,
    videoGBPerMonth: (bytesPerSecond * 86400 * days) / 1e9,
    ringBuffer60sMB: (bytesPerSecond * 60) / 1e6,
    averageClipMB: ((bytesPerSecond / bitrates.length) * clipSeconds) / 1e6,
    clipsRetentionMB:
      ((bytesPerSecond / bitrates.length) *
        clipSeconds *
        eventsPerDay *
        retentionDays) /
      1e6,
    framesPerDay,
    apiFrameLimit: 500,
    apiQuotaRatio: framesPerDay / 500,
    inferenceCPUHours: (framesPerDay * days * cpuMs) / 3600000,
    residentRunnerMinutes: days * 1440,
    githubFreeComputeUSD: 12,
    githubBaselineIncludedMinutes: 12 / 0.006,
    githubSlimIncludedMinutes: 12 / 0.002,
    baselineMonthlyComputeUSD: days * 1440 * 0.006,
    slimMonthlyComputeUSD: days * 1440 * 0.002,
    hourlyJobMinutesAt2min: days * 24 * 2,
    hourly20sWindowCoveragePercent: (20 / 3600) * 100,
    continuousCVReady: false,
  };
}
if (import.meta.url === new URL(process.argv[1], "file:").href)
  console.log(JSON.stringify(iowaBudget(), null, 2));
