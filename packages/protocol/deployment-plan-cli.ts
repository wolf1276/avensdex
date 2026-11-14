// Offline deployment-plan builder. Reads external planner input and reviewed artifacts only.
// No signer, wallet, RPC, broadcast, activation or journal mutation is implemented here.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildDeploymentPlan, type DeploymentPlan } from './deployment.ts';

export const MAX_DEPLOYMENT_PLAN_FILE_BYTES = 1024 * 1024;
export const MAX_DEPLOYMENT_PLAN_PATH_LENGTH = 4096;

export interface DeploymentPlanFiles { inputPath: string; artifactsPath: string }

export function parseDeploymentPlanArgs(args: readonly string[]): DeploymentPlanFiles {
  if (args.length !== 2 || args.some(arg => !arg || arg.length > MAX_DEPLOYMENT_PLAN_PATH_LENGTH)) {
    throw Error('INVALID_DEPLOYMENT_PLAN_ARGS');
  }
  return { inputPath: args[0]!, artifactsPath: args[1]! };
}

function readJson(path: string, unavailable: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw Error(unavailable);
  }
  try {
    let stats;
    try { stats = fstatSync(fd); } catch { throw Error(unavailable); }
    if (!stats.isFile()) throw Error('DEPLOYMENT_PLAN_FILE_NOT_REGULAR');
    if (stats.size <= 0 || stats.size > MAX_DEPLOYMENT_PLAN_FILE_BYTES) throw Error('DEPLOYMENT_PLAN_FILE_CAPACITY');

    const buffer = Buffer.alloc(MAX_DEPLOYMENT_PLAN_FILE_BYTES + 1);
    let total = 0;
    try {
      while (total < buffer.length) {
        const read = readSync(fd, buffer, total, buffer.length - total, null);
        if (read === 0) break;
        total += read;
      }
    } catch {
      throw Error(unavailable);
    }
    if (total <= 0 || total > MAX_DEPLOYMENT_PLAN_FILE_BYTES || total !== stats.size) {
      throw Error('DEPLOYMENT_PLAN_FILE_CAPACITY');
    }
    const text = buffer.subarray(0, total).toString('utf8');
    try { return JSON.parse(text); } catch { throw Error('INVALID_DEPLOYMENT_PLAN_JSON'); }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* descriptor cleanup must not mask the original error */ }
    }
  }
}

export function buildDeploymentPlanFromFiles(inputPath: string, artifactsPath: string, now: number): DeploymentPlan {
  const input = readJson(inputPath, 'DEPLOYMENT_PLAN_INPUT_UNAVAILABLE');
  const artifacts = readJson(artifactsPath, 'DEPLOYMENT_PLAN_ARTIFACTS_UNAVAILABLE');
  return buildDeploymentPlan(input, artifacts, now);
}

function main() {
  const { inputPath, artifactsPath } = parseDeploymentPlanArgs(process.argv.slice(2));
  const plan = buildDeploymentPlanFromFiles(inputPath, artifactsPath, Math.floor(Date.now() / 1000));
  console.log(JSON.stringify(plan));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,120}$/.test(error.message) ? error.message : 'DEPLOYMENT_PLAN_FAILED';
    console.error(`Deployment plan failed: ${code}. No transaction was signed or sent.`);
    process.exitCode = 1;
  }
}
