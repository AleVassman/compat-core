import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { 
  verifyEnvironmentBlock, 
  createSandboxBlock, 
  cleanupSandboxBlock, 
  generateReportBlock,
  generateJsonReport,
  runBisectionBlock
} from './utils/engine.js';

// --- ADAPTER REGISTRY ---
import * as nodeAdapter from './utils/adapters/node.js';
import * as pythonAdapter from './utils/adapters/python.js';
import * as staticAdapter from './utils/adapters/static.js';

const ADAPTERS = [nodeAdapter, pythonAdapter, staticAdapter];

/**
 * Fingerprint resolver: Finds the correct adapter for the target project
 */
function resolveAdapter(targetDir) {
  const activeAdapter = ADAPTERS.find(adapter => adapter.detect(targetDir));
  if (!activeAdapter) {
    throw new Error(
      'No compatible language stack or package manifest (package.json or requirements.txt) was detected in this directory.'
    );
  }
  return activeAdapter;
}

/**
 * Main optimizer entry point orchestrating all steps
 */
export async function runOptimizer(options) {
  const targetDir = process.cwd();

  // If JSON output mode is active, route status logs to stderr so stdout is 100% pure JSON
  if (options.json) {
    console.log = (...args) => console.error(...args);
  }

  // 1. Auto-detect the project stack and load the correct Adapter
  const adapter = resolveAdapter(targetDir);

  // Resolve the active manifest filename dynamically from the active adapter
  const manifestName = adapter.getManifestName(targetDir);

  console.log('🔍 Executing pre-flight environment checks...');
  const env = verifyEnvironmentBlock(targetDir, options, manifestName);

  // Resolve active package manager dynamically from the adapter
  const activePackageManager = adapter.getPackageManagerName(targetDir);

  // --- STEP 1: INTERCEPT RESTORE FLAG (RESTORE) ---
  if (options.restore) {
    try {
      adapter.restore(targetDir, activePackageManager);
      if (options.json) {
        process.stdout.write(JSON.stringify({ action: 'restore', status: 'success' }, null, 2) + '\n');
      }
      return { success: true, action: 'restore' };
    } catch (err) {
      console.error('\n❌ Rollback failed:', err.message);
      if (options.json) {
        process.stdout.write(JSON.stringify({ action: 'restore', status: 'error', error: err.message }, null, 2) + '\n');
      }
      process.exit(1);
    }
  }

  const upgradeScope = options.patchOnly ? 'PATCH ONLY' 
                     : options.minorOnly ? 'MINOR & PATCH ONLY' 
                     : 'FULL (MAJOR, MINOR, PATCH)';

  console.log('\n--- Pre-Flight Environment Analysis ---');
  console.log(`Target Directory: ${targetDir}`);
  console.log(`Project Stack:    ${adapter.name.toUpperCase()}`);
  console.log(`Package Manager:  ${activePackageManager.toUpperCase()}`);
  console.log(`Upgrade Scope:    ${upgradeScope}`);
  console.log(`Git Repository:   ${env.hasGit ? 'Yes' : 'No'}`);
  console.log(`Sandbox Mode:     ${options.sandbox ? 'Enabled' : 'Disabled (Local Git Branching)'}`);
  console.log(`Apply Upgrades:   ${options.apply ? 'Yes' : 'No (Dry Run / Analysis Only)'}`);
  console.log('---------------------------------------\n');

  // --- STEP 2: SCAN REGISTRY FOR UPDATES ---
  const scanResults = await adapter.scanUpdates(targetDir);
  let availableUpgrades = scanResults.upgrades;
  const errors = scanResults.errors;

  // Apply Granular Upgrade Filters if specified
  if (options.patchOnly) {
    availableUpgrades = availableUpgrades.filter(pkg => pkg.updateType === 'patch');
  } else if (options.minorOnly) {
    availableUpgrades = availableUpgrades.filter(pkg => pkg.updateType === 'patch' || pkg.updateType === 'minor');
  }

  console.log('\n--- Registry Update Scan Summary ---');
  console.log(`Total Dependencies Scanned: ${scanResults.totalScanned}`);
  console.log(`Already Up To Date:         ${scanResults.upToDate}`);
  console.log(`Upgrades Available:         ${availableUpgrades.length}`);
  console.log(`Errors (Unresolvable):      ${errors.length}`);
  
  if (availableUpgrades.length === 0) {
    if (adapter.name === 'static') {
      console.log('\n🔍 Static Audit Mode: Scanning codebase for deprecated APIs...');
      const detectedIssues = await adapter.scanDeprecations(targetDir, [], env.excludeList);
      generateReportBlock(targetDir, [], [], detectedIssues, options, { ...env, packageManager: 'none', scope: upgradeScope, projectStack: adapter.name });
      console.log('\n============================================================');
      console.log('✅ Static audit complete. Codebase is secure.');
      return { success: true, hasBlocked: false, safeCount: 0, blockedCount: 0, safePackages: [], blockedGroups: [], detectedIssues };
    }

    if (scanResults.upgrades.length > 0) {
      console.log(`🎉 No upgrades match your specified filter scope (${options.patchOnly ? '--patch-only' : '--minor-only'}).`);
    } else {
      console.log('🎉 Your project dependencies are 100% up to date! Nothing to optimize.');
    }

    generateReportBlock(targetDir, [], [], [], options, { ...env, packageManager: activePackageManager, scope: upgradeScope, projectStack: adapter.name });
    return { success: true, hasBlocked: false, safeCount: 0, blockedCount: 0, safePackages: [], blockedGroups: [], detectedIssues: [] };
  }

  // --- STEP 3: SOLVE CONSTRAINTS & GROUP ATOMIC UNITS ---
  console.log('\n⛓️  Solving co-dependency constraints and mapping atomic units...');
  const solution = adapter.solve(availableUpgrades);

  // --- STEP 4, 5 & Baseline: INITIALIZE SANDBOX & RUN VALIDATIONS ---
  let sandboxContext = null;
  let finalSafeGroups = [];
  let finalBlockedGroups = [];
  let validationPassed = false;

  const originalManifest = adapter.loadManifest(targetDir, manifestName);

  try {
    sandboxContext = createSandboxBlock(targetDir, options, originalManifest, env.excludeList);

    console.log(`\n📂 Active Directory switched to sandbox: ${process.cwd()}`);
    
    // --- ABSTRACT PRE-UPGRADE BASELINE HEALTH CHECK ---
    console.log('🔍 Running pre-upgrade Baseline Check to verify codebase health...');
    
    const baselineResult = await adapter.validate(
      sandboxContext.sandboxPath,
      activePackageManager,
      originalManifest,
      [],
      options
    );

    if (!baselineResult.passed) {
      console.error('\n❌ Early-Exit Aborted: Your project is already failing validation checks in its current state.');
      console.error(`Please fix the pre-existing Tier ${baselineResult.tier} errors before optimizing your dependencies:\n`);
      console.error(String(baselineResult.error || '').trim().split('\n').slice(-20).map(line => `    | ${line}`).join('\n'));
      
      if (options.json) {
        generateJsonReport(targetDir, [], [{ group: { id: 'BASELINE_CHECK', packages: [] }, tier: baselineResult.tier, error: baselineResult.error }], [], options, { ...env, packageManager: activePackageManager, scope: upgradeScope, projectStack: adapter.name });
      }
      return { success: false, baselineFailed: true, hasBlocked: true, blockedCount: 1 };
    }

    console.log('✅ Baseline check passed: Original codebase compiles, builds, and boots cleanly.');

    // --- STEP 5: THE UPGRADE ATTEMPTS ---
    console.log('\n🧪 Commencing "Big-Bang" full-upgrade validation check in sandbox...');

    const bigBangResult = await adapter.validate(
      sandboxContext.sandboxPath, 
      activePackageManager, 
      originalManifest, 
      solution.atomicGroups, 
      options
    );

    if (bigBangResult.passed) {
      console.log('🌟 "Big-Bang" upgrade validation succeeded! All dependencies are mutually compatible.');
      finalSafeGroups = solution.atomicGroups;
      validationPassed = true;
    } else {
      console.log(`\n❌ "Big-Bang" validation failed during Tier ${bigBangResult.tier}.`);
      console.log('⚙️  Initiating recursive bisection algorithm to isolate stable upgrade paths... (This may take several minutes)');
      
      const bisectionResult = await runBisectionBlock(
        adapter,
        sandboxContext.sandboxPath,
        activePackageManager,
        originalManifest,
        solution.atomicGroups,
        options
      );

      finalSafeGroups = bisectionResult.safeGroups;
      finalBlockedGroups = bisectionResult.blockedGroups;
      validationPassed = finalSafeGroups.length > 0;
    }

  } finally {
    if (sandboxContext) {
      cleanupSandboxBlock(sandboxContext, options);
    }
  }

  const safePackages = finalSafeGroups.flatMap(group => group.packages);

  // --- STEP 6: CODE QUALITY SCAN FOR DEPRECATED APIS ---
  let detectedIssues = [];
  if (validationPassed && safePackages.length > 0 && typeof adapter.scanDeprecations === 'function') {
    console.log('\n🔍 Initiating code inspection scanner for breaking changes on verified upgrades...');
    detectedIssues = await adapter.scanDeprecations(targetDir, safePackages, env.excludeList);
  }

  // --- STEP 7 & 8: PRESENTATION (REPORTER) & LOCAL APPLY ---
  generateReportBlock(targetDir, safePackages, finalBlockedGroups, detectedIssues, options, { ...env, packageManager: activePackageManager, scope: upgradeScope, projectStack: adapter.name });

  if (options.apply && safePackages.length > 0) {
    adapter.backup(targetDir, activePackageManager);

    console.log('\n💾 Applying verified safe upgrades back to local project requirements.txt...');
    adapter.apply(targetDir, safePackages);
    
    console.log('📦 Re-syncing local package environment...');
    const syncCmd = adapter.getSyncCommand(targetDir);

    if (syncCmd) {
      try {
        execSync(syncCmd, { cwd: targetDir, stdio: 'inherit' });
        console.log('\n💾 Local environment successfully synchronized with upgrades!');
      } catch {
        console.error('\n⚠️ Failed to automatically re-sync local environment. Please run pip install manually.');
      }
    }
  } else if (safePackages.length > 0 && !options.json) {
    console.log('\n💡 Tip: To automatically apply these safe upgrades, re-run with the --apply flag:');
    console.log(`   compat-core --sandbox --apply ${options.patchOnly ? '--patch-only' : options.minorOnly ? '--minor-only' : ''}`.trim());
  }

  // GitHub Actions Workflow Error Annotations
  if (process.env.GITHUB_ACTIONS === 'true' && finalBlockedGroups.length > 0) {
    finalBlockedGroups.forEach(block => {
      console.error(`::error title=Blocked Upgrade [${block.group.id}]::Failed validation in Tier ${block.tier}. See COMPAT_REPORT.md for diagnostics.`);
    });
  }

  console.log('\n============================================================');
  console.log('✅ Optimization flow complete. Codebase is secure.');

  return {
    success: finalBlockedGroups.length === 0,
    hasBlocked: finalBlockedGroups.length > 0,
    safeCount: safePackages.length,
    blockedCount: finalBlockedGroups.length,
    safePackages,
    blockedGroups: finalBlockedGroups,
    detectedIssues
  };
}