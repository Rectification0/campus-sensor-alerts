// Load-test probe, preloaded into the server only by `pnpm loadtest`
// (node --import ./loadtest/probe.mjs dist/server.js). It measures the server from the
// inside and answers over the IPC channel, so sampling spawns no processes and does not
// disturb the measurement. Production runs never load this file.

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

if (process.send) {
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();

  let cpu = process.cpuUsage();
  let elu = performance.eventLoopUtilization();
  let started = performance.now();
  let peakRss = process.memoryUsage.rss();
  const rssTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }, 50);
  rssTimer.unref();

  process.on('message', (msg) => {
    if (msg === 'probe:start') {
      cpu = process.cpuUsage();
      elu = performance.eventLoopUtilization();
      started = performance.now();
      peakRss = process.memoryUsage.rss();
      loopDelay.reset();
      process.send({ type: 'probe:started' });
    } else if (msg === 'probe:stop') {
      const used = process.cpuUsage(cpu);
      const wallMs = performance.now() - started;
      process.send({
        type: 'probe:result',
        avgCpuPercent: Math.round(((used.user + used.system) / 1000 / wallMs) * 100),
        eventLoopUtilizationPercent: Math.round(
          performance.eventLoopUtilization(elu).utilization * 100,
        ),
        eventLoopDelayMaxMs: Math.round(loopDelay.max / 1e6),
        peakMemoryMb: Math.round(peakRss / 1024 / 1024),
      });
    } else if (msg === 'probe:shutdown') {
      // Windows has no real SIGTERM for child processes; trigger the server's own
      // graceful-shutdown handler instead of a hard kill.
      process.emit('SIGTERM', 'SIGTERM');
    }
  });
  // The IPC channel must not keep the server alive on its own.
  process.channel?.unref();
}
