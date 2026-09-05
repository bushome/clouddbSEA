'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, 'watchdog-config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const logFile = path.isAbsolute(config.logFile)
  ? config.logFile
  : path.join(__dirname, config.logFile);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch (err) {
    console.error(`Failed to write watchdog log: ${err.message}`);
  }
}

let child = null;
let healthTimer = null;
let startupTimer = null;
let currentBackoffMs = config.backoffStartMs;
let crashTimestamps = [];
let lastHealthyAt = null;
let shuttingDown = false;

function recordCrash() {
  const now = Date.now();
  crashTimestamps.push(now);
  crashTimestamps = crashTimestamps.filter((t) => now - t <= config.crashWindowMs);
  return crashTimestamps.length;
}

function resetBackoffIfHealthyLongEnough() {
  if (lastHealthyAt && Date.now() - lastHealthyAt >= config.healthyResetMs) {
    if (currentBackoffMs !== config.backoffStartMs) {
      log(`Process stable for ${config.healthyResetMs}ms — resetting backoff to ${config.backoffStartMs}ms.`);
    }
    currentBackoffMs = config.backoffStartMs;
    crashTimestamps = [];
  }
}

function checkHealth() {
  resetBackoffIfHealthyLongEnough();

  const req = http.get(config.healthUrl, { timeout: config.healthTimeoutMs }, (res) => {
    if (res.statusCode === 200) {
      if (!lastHealthyAt) log('Health check passed.');
      lastHealthyAt = Date.now();
    } else {
      log(`Health check returned status ${res.statusCode} — treating as unhealthy.`);
      handleUnhealthy();
    }
    res.resume();
  });

  req.on('timeout', () => {
    req.destroy();
    log(`Health check timed out after ${config.healthTimeoutMs}ms — treating as unhealthy.`);
    handleUnhealthy();
  });

  req.on('error', (err) => {
    log(`Health check request failed: ${err.message} — treating as unhealthy.`);
    handleUnhealthy();
  });
}

function handleUnhealthy() {
  if (shuttingDown) return;
  log('Restarting child process due to failed health check.');
  if (child) {
    child.removeAllListeners('exit');
    child.kill();
  }
  restartChild('unresponsive (health check)');
}

function startHealthChecks() {
  stopHealthChecks();
  healthTimer = setInterval(checkHealth, config.healthIntervalMs);
}

function stopHealthChecks() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

function launchChild() {
    const command = config.isExe ? path.join(config.appDir, config.appEntry) : 'node';
    const args = config.isExe ? [] : [config.appEntry];
    log(`Launching child process: ${config.isExe ? config.appEntry : `node ${config.appEntry}`} (cwd: ${config.appDir})`);
    lastHealthyAt = null;
    child = spawn(command, args, {
        cwd: config.appDir,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => process.stdout.write(data));
    child.stderr.on('data', (data) => process.stderr.write(data));
    child.on('exit', (code, signal) => {
        if (shuttingDown) return;
        log(`Child process exited (code=${code}, signal=${signal}).`);
        stopHealthChecks();
        restartChild(`exited with code ${code}`);
    });
    child.on('error', (err) => {
        if (shuttingDown) return;
        log(`Child process failed to start: ${err.message}`);
        stopHealthChecks();
        restartChild(`failed to start: ${err.message}`);
    });
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = setTimeout(() => {
        startHealthChecks();
    }, config.startupGraceMs);
}

function restartChild(reason) {
  const crashCount = recordCrash();
  log(`Crash #${crashCount} in current ${config.crashWindowMs}ms window (reason: ${reason}).`);

  if (crashCount > config.maxCrashesInWindow) {
    log(
      `Crash limit exceeded (${crashCount} > ${config.maxCrashesInWindow} within ${config.crashWindowMs}ms). ` +
        `Halting auto-restart. Manual intervention required — check logs, config.json, and recent deployment changes.`,
    );
    // Intentionally not exiting the watchdog itself, so it stays alive to
    // log the situation and can be manually told to retry later if desired
    // (e.g. by restarting this watchdog process once the issue is fixed).
    return;
  }

  log(`Waiting ${currentBackoffMs}ms before restart attempt.`);
  setTimeout(() => {
    launchChild();
  }, currentBackoffMs);

  currentBackoffMs = Math.min(currentBackoffMs * config.backoffMultiplier, config.backoffMaxMs);
}

function shutdown(signal) {
  shuttingDown = true;
  log(`Watchdog received ${signal} — shutting down child process.`);
  stopHealthChecks();
  if (startupTimer) clearTimeout(startupTimer);
  if (child) {
    child.removeAllListeners('exit');
    child.kill();
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log('Watchdog starting.');
launchChild();