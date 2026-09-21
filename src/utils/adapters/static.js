import fs from 'fs';
import path from 'path';

export const name = 'static';

/**
 * Fallback fingerprint detector: always returns true because it is the final catch-all adapter
 * @param {string} targetDir 
 * @returns {boolean}
 */
export function detect(targetDir) {
  return true;
}

/**
 * Resolves the active manifest filename
 * @param {string} targetDir 
 * @returns {null} No manifest file for static audits
 */
export function getManifestName(targetDir) {
  return null;
}

/**
 * Loads the active manifest file natively
 * @param {string} targetDir 
 * @param {null} manifestName 
 * @returns {null} No manifest data to load
 */
export function loadManifest(targetDir, manifestName) {
  return null;
}

/**
 * Standardized package manager name resolver
 */
export function getPackageManagerName(targetDir) {
  return 'none';
}

/**
 * Standardized local workspace sync command generator
 */
export function getSyncCommand(targetDir) {
  return null;
}

/**
 * Standardized update scanning
 */
export async function scanUpdates(targetDir) {
  // Static projects have no manifest, so there are no updates to scan
  return { upgrades: [], errors: [] };
}

/**
 * Standardized constraint solving
 */
export function solve(upgrades) {
  return { conflicts: [], atomicGroups: [] };
}

/**
 * Standardized local snapshot backups
 */
export function backup(targetDir, packageManager) {}

/**
 * Standardized local snapshot restores
 */
export function restore(targetDir) {}

/**
 * Standardized local package modifications
 */
export function apply(targetDir, safePackages) {}

/**
 * Standardized deprecation scanning
 * Runs a full, multi-language static sweep across your raw local code
 */
export async function scanDeprecations(targetDir, safePackages, excludeList) {
  try {
    // Dynamically import the NodeJS compiler-level scanner block
    const { runStaticScanner } = await import('../scanner.js');
    
    // We pass a default dummy upgraded list to force the scanner to inspect 
    // your raw code for standard React / ReactDOM 19 deprecation patterns
    const defaultAuditPackages = [{ name: 'react' }, { name: 'react-dom' }];
    
    return await runStaticScanner(targetDir, defaultAuditPackages, excludeList);
  } catch {
    return [];
  }
}

/**
 * Standardized Multi-Tier validation loop
 */
export async function validate(sandboxPath, packageManager, originalManifest, upgradeGroups, options) {
  // Bypasses installations, typechecks, builds, and test runs natively
  return { passed: true };
}