#!/usr/bin/env node

import { startCoreDaemonProcess } from "./daemon.js";

try {
  await startCoreDaemonProcess();
} catch (error) {
  process.stderr.write(
    `Densa Core failed to start: ${error instanceof Error ? error.message : "unknown failure"}\n`,
  );
  process.exitCode = 1;
}
