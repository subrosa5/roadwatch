import { capacity } from "../src/domain.mjs";
const rows = [];
for (const cameras of [50, 100])
  for (const fps of [1 / 1800, 1 / 300, 1 / 60, 1, 2])
    rows.push(capacity({ cameras, fps, bitrateMbps: 1, cpuMs: 50 }));
console.table(
  rows.map((r) => ({
    cameras: r.cameras,
    sampling: r.fps < 1 ? `1/${Math.round(1 / r.fps)}s` : `${r.fps}fps`,
    framesDay: Math.round(r.framesPerDay),
    cpuHoursMonth: Math.round(r.cpuHoursMonth * 10) / 10,
    ingestGBDay: r.ingestGBDay,
    ringGB: r.ringBufferGB60s,
    cpuOnlyFitsHobby: r.theoreticalVercelCPUFit,
  })),
);
