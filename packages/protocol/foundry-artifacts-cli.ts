// Offline Foundry artifact extraction for the paused deployment planner.
// Reads only fixed Foundry output paths. No signer, RPC, broadcast, activation, source review or runtime qualification.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from './deployment-plan-cli.ts';

export const FOUNDRY_ARTIFACT_NAMES = ['AvensVault', 'AvensFeedOracle', 'AvensSettlement'] as const;
export type FoundryArtifactName = (typeof FOUNDRY_ARTIFACT_NAMES)[number];
export interface FoundryArtifact { abi: unknown; bytecode: string }
export type FoundryArtifacts = Record<FoundryArtifactName, FoundryArtifact>;

export const MAX_FOUNDRY_OUT_DIR_PATH_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function foundryArtifactPath(outDir: string, name: FoundryArtifactName): string {
  return join(outDir, `${name}.sol`, `${name}.json`);
}

export function parseFoundryArtifactsArgs(args: readonly string[]): string {
  if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length === 0
    || args[0].length > MAX_FOUNDRY_OUT_DIR_PATH_LENGTH) {
    throw Error('INVALID_FOUNDRY_ARTIFACT_ARGS');
  }
  return args[0];
}

function normalizeArtifact(raw: unknown): FoundryArtifact {
  if (!isRecord(raw)) throw Error('INVALID_FOUNDRY_ARTIFACT');
  if (!Array.isArray(raw.abi) || raw.abi.length === 0 || raw.abi.length > 4096) {
    throw Error('INVALID_FOUNDRY_ARTIFACT_ABI');
  }
  const bytecode = raw.bytecode;
  if (!isRecord(bytecode)) throw Error('INVALID_FOUNDRY_ARTIFACT_BYTECODE');
  const object = bytecode.object;
  if (typeof object !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(object)) {
    throw Error('INVALID_FOUNDRY_ARTIFACT_BYTECODE');
  }
  const linkReferences = bytecode.linkReferences;
  if (linkReferences !== undefined) {
    if (!isRecord(linkReferences) || Object.keys(linkReferences).length !== 0) {
      throw Error('UNRESOLVED_FOUNDRY_LINK_REFERENCE');
    }
  }
  return { abi: raw.abi, bytecode: object.toLowerCase() };
}

export function prepareFoundryArtifacts(outDir: string): FoundryArtifacts {
  const result = {} as FoundryArtifacts;
  for (const name of FOUNDRY_ARTIFACT_NAMES) {
    const raw = readJson(foundryArtifactPath(outDir, name), 'FOUNDRY_ARTIFACT_UNAVAILABLE');
    result[name] = normalizeArtifact(raw);
  }
  return result;
}

function main() {
  const outDir = parseFoundryArtifactsArgs(process.argv.slice(2));
  const artifacts = prepareFoundryArtifacts(outDir);
  console.log(JSON.stringify(artifacts));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,120}$/.test(error.message) ? error.message : 'FOUNDRY_ARTIFACT_PREPARATION_FAILED';
    console.error(`Foundry artifact preparation failed: ${code}. No transaction was signed or sent.`);
    process.exitCode = 1;
  }
}
