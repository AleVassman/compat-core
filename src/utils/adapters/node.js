import fs from 'fs';
import path from 'path';
import { createBackupBlock, restoreBackupBlock } from '../engine.js';
import { scanRegistryUpdates } from '../registry.js';
import { solve as solveConstraints } from '../solver.js';
import { runStaticScanner } from '../scanner.js';
import { 
  applyUpgradesToPackageJson, 
  runInstallation, 
  runTypeCheck, 
  runBuild, 
  runTests,
  runSmokeTest 
} from '../validator.js';

export const name = 'nodejs';

/**
 * Fingerprint detector: returns true if this project is a NodeJS project
 * @param {string} targetDir 
 * @returns {boolean}
 */
export function detect(targetDir) {
  return fs.existsSync(path.join(targetDir, 'package.json'));
}

/**
 * Resolves the active manifest filename for the project
 * @param {string} targetDir 
 * @returns {string}
 */
export function getManifestName(targetDir) {
  return 'package.json';
}

/**
 * Loads and parses the manifest file natively as a JSON object
 * @param {string} targetDir 
 * @param {string} manifestName 
 * @returns {object}
 */
export function loadManifest(targetDir, manifestName) {
  const manifestPath = path.join(targetDir, manifestName);
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
}

/**
 * Detects which package manager is used by the target project
 * @param {string} targetDir 
 * @returns {'npm' | 'pnpm' | 'yarn' | 'bun'}
 */
export function detectPackageManager(targetDir) {
  if (fs.existsSync(path.join(targetDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(targetDir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(targetDir, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/**
 * Resolves the standardized package manager name
 * @param {string} targetDir 
 * @returns {string}
 */
export function getPackageManagerName(targetDir) {
  return detectPackageManager(targetDir);
}

/**
 * Generates the local package manager sync command
 * @param {string} targetDir 
 * @returns {string}
 */
export function getSyncCommand(targetDir) {
  const pm = detectPackageManager(targetDir);
  switch (pm) {
    case 'pnpm': return 'pnpm install';
    case 'yarn': return 'yarn install';
    case 'bun': return 'bun install';
    default: return 'npm install --legacy-peer-deps';
  }
}

/**
 * Standardized update scanning
 * @param {string} targetDir 
 */
export async function scanUpdates(targetDir) {
  return await scanRegistryUpdates(targetDir);
}

/**
 * Standardized constraint solving
 * @param {Array<object>} upgrades 
 */
export function solve(upgrades) {
  return solveConstraints(upgrades);
}

/**
 * Standardized local snapshot backups
 * @param {string} targetDir 
 * @param {string} packageManager 
 */
export function backup(targetDir, packageManager) {
  const lockfileName = packageManager === 'pnpm' ? 'pnpm-lock.yaml' 
                     : packageManager === 'yarn' ? 'yarn.lock' 
                     : packageManager === 'bun' ? 'bun.lockb' 
                     : 'package-lock.json';
  createBackupBlock(targetDir, 'package.json', lockfileName);
}

/**
 * Standardized local snapshot restores
 * @param {string} targetDir 
 */
export function restore(targetDir) {
  restoreBackupBlock(targetDir, getSyncCommand(targetDir));
}

/**
 * Standardized local package JSON modifications
 * @param {string} targetDir 
 * @param {Array<object>} safePackages 
 */
export function apply(targetDir, safePackages) {
  return applyUpgradesToPackageJson(targetDir, safePackages);
}

/**
 * Standardized deprecation scanning
 * @param {string} targetDir 
 * @param {Array<object>} safePackages 
 * @param {Array<string>} excludeList 
 */
export async function scanDeprecations(targetDir, safePackages, excludeList) {
  return await runStaticScanner(targetDir, safePackages, excludeList);
}

/**
 * Standardized Multi-Tier validation loop
 */
export async function validate(sandboxPath, packageManager, originalPackageJson, upgradeGroups, options) {
  fs.writeFileSync(path.join(sandboxPath, 'package.json'), JSON.stringify(originalPackageJson, null, 2), 'utf-8');
  
  const upgradesToApply = upgradeGroups.flatMap(group => group.packages);
  if (upgradesToApply.length > 0) {
    applyUpgradesToPackageJson(sandboxPath, upgradesToApply);
  }

  const currentPackageJson = JSON.parse(fs.readFileSync(path.join(sandboxPath, 'package.json'), 'utf-8'));

  const installResult = runInstallation(sandboxPath, packageManager, options);
  if (!installResult.passed) return { passed: false, tier: 'A (Installation)', error: installResult.error };

  const typeResult = runTypeCheck(sandboxPath, packageManager);
  if (!typeResult.passed) return { passed: false, tier: 'B (TypeScript Compilation)', error: typeResult.error };

  const buildResult = runBuild(sandboxPath, packageManager, currentPackageJson);
  if (!buildResult.passed) return { passed: false, tier: 'C (Production Build)', error: buildResult.error };

  const smokeResult = await runSmokeTest(sandboxPath, packageManager, currentPackageJson, options);
  if (!smokeResult.passed) return { passed: false, tier: 'E (Boot-Up Smoke Test)', error: smokeResult.error };

  const testResult = await runTests(sandboxPath, packageManager, currentPackageJson, options);
  if (!testResult.passed) return { passed: false, tier: 'D (Test Suites)', error: testResult.error };

  return { passed: true };
}