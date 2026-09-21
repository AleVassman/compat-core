import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const BACKUP_FILENAME = '.compat-backup.json';

// ==========================================
// 1. ENVIRONMENT & GIT BLOCKS
// ==========================================

export function isGitRepository(targetDir) {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: targetDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function isGitClean(targetDir) {
  try {
    const status = execSync('git status --porcelain', { cwd: targetDir, encoding: 'utf-8' });
    return status.trim() === '';
  } catch {
    return false;
  }
}

export function parseGitIgnore(targetDir) {
  const gitIgnorePath = path.join(targetDir, '.gitignore');
  const defaultExcludes = ['node_modules', '.git', 'coverage', 'compat-sandbox-'];

  if (!fs.existsSync(gitIgnorePath)) {
    return defaultExcludes;
  }

  try {
    const content = fs.readFileSync(gitIgnorePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const excludes = new Set(defaultExcludes);

    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      let clean = trimmed
        .replace(/^\/+|\/+$/g, '')
        .replace(/\/\*+$/, '')
        .replace(/\*+$/, '')
        .trim();

      if (clean && !clean.startsWith('.env')) {
        excludes.add(clean);
      }
    });

    return Array.from(excludes);
  } catch {
    return defaultExcludes;
  }
}

export function verifyEnvironmentBlock(targetDir, options, manifestName) {
  const hasGit = isGitRepository(targetDir);

  if (!options.sandbox && !options.restore) {
    if (!hasGit) {
      throw new Error(
        'Target directory is not a Git repository. Run with --sandbox to safely test outside of Git control.'
      );
    }
  }

  if (manifestName) {
    const manifestPath = path.join(targetDir, manifestName);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No ${manifestName} found in the target directory.`);
    }
  }

  return {
    hasGit,
    excludeList: parseGitIgnore(targetDir)
  };
}

// ==========================================
// 2. SANDBOX & TSCONFIG BLOCKS
// ==========================================

function copyRecursiveSync(src, dest, excludeList = []) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  const baseName = path.basename(src);

  if (excludeList.includes(baseName)) return;

  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(
        path.join(src, childItemName),
        path.join(dest, childItemName),
        excludeList
      );
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}

export function patchSandboxTsConfigBlock(sandboxPath, excludeList) {
  const tsconfigPath = path.join(sandboxPath, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return;

  const subDirs = fs.readdirSync(sandboxPath, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && !excludeList.includes(dirent.name))
    .map(dirent => dirent.name);

  const isolatedDirs = [];

  subDirs.forEach(dir => {
    const subDirPath = path.join(sandboxPath, dir);
    const subPackageJson = path.join(subDirPath, 'package.json');

    if (fs.existsSync(subPackageJson)) {
      isolatedDirs.push(dir);
    }
  });

  if (isolatedDirs.length === 0) return;

  console.log(`📂 TSConfig Patch: Dynamically excluding isolated sub-projects: [${isolatedDirs.join(', ')}]`);

  try {
    const tsconfigContent = fs.readFileSync(tsconfigPath, 'utf-8');
    const stripCommentsRegex = /("(?:[^"\\]|\\.)*")|(\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|\/\/.*)/g;
    let cleanJson = tsconfigContent.replace(stripCommentsRegex, (m, g1, g2) => g2 ? "" : g1);

    const stripTrailingCommasRegex = /,\s*([\]}])/g;
    cleanJson = cleanJson.replace(stripTrailingCommasRegex, "$1");

    const tsconfig = JSON.parse(cleanJson);

    if (!tsconfig.exclude) {
      tsconfig.exclude = [];
    }

    isolatedDirs.forEach(dir => {
      if (!tsconfig.exclude.includes(dir)) {
        tsconfig.exclude.push(dir);
      }
    });

    fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf-8');
    console.log('📂 TSConfig Patch: Sandbox config updated successfully.');
  } catch (err) {
    console.warn(`⚠️ Warning: Failed to patch sandbox tsconfig.json: ${err.message}`);
  }
}

export function createSandboxBlock(targetDir, options, originalManifest, excludeList) {
  if (!originalManifest) {
    return {
      mode: 'static',
      originalDir: targetDir,
      sandboxPath: targetDir,
      originalBranch: null
    };
  }
  const context = {
    mode: options.sandbox ? 'temp-dir' : 'git-branch',
    originalDir: targetDir,
    sandboxPath: targetDir,
    originalBranch: null,
  };

  const activeExcludes = excludeList && excludeList.length > 0 
    ? excludeList 
    : ['node_modules', '.git', 'coverage', 'compat-sandbox-'];

  if (options.sandbox) {
    console.log('📂 Creating OS temporary directory sandbox... (Windows compatibility active)');
    const tempPrefix = path.join(os.tmpdir(), 'compat-sandbox-');
    const tempDir = fs.mkdtempSync(tempPrefix);
    
    console.log(`📂 Copying project files to isolated sandbox: ${tempDir}`);
    copyRecursiveSync(targetDir, tempDir, activeExcludes);

    context.sandboxPath = tempDir;
    patchSandboxTsConfigBlock(tempDir, activeExcludes);
    process.chdir(tempDir);
  } else {
    console.log('🌿 Initializing local Git branching sandbox...');
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: targetDir, encoding: 'utf-8' }).trim();
    context.originalBranch = currentBranch;

    console.log('🌿 Creating temporary git branch: _compat-check-temp');
    execSync('git checkout -b _compat-check-temp', { cwd: targetDir, stdio: 'ignore' });

    patchSandboxTsConfigBlock(targetDir, activeExcludes);
  }

  return context;
}

export function cleanupSandboxBlock(context, options) {
  if (context && context.mode === 'static') {
    return;
  }

  console.log('\n🧹 Starting sandbox cleanup and state restoration...');

  if (context.mode === 'temp-dir') {
    process.chdir(context.originalDir);

    console.log(`🧹 Removing temp sandbox directory: ${context.sandboxPath}`);
    try {
      fs.rmSync(context.sandboxPath, { 
        recursive: true, 
        force: true, 
        maxRetries: 20,
        retryDelay: 150
      });
    } catch (err) {
      console.warn(`⚠️ Warning: Failed to clean up temp folder automatically: ${err.message}`);
    }
  } else {
    console.log(`🌿 Switching back to original Git branch: ${context.originalBranch}`);
    execSync(`git checkout ${context.originalBranch}`, { cwd: context.originalDir, stdio: 'ignore' });
    
    console.log('🌿 Deleting temporary git branch: _compat-check-temp');
    execSync('git branch -D _compat-check-temp', { cwd: context.originalDir, stdio: 'ignore' });
  }

  console.log('🧹 Cleanup and state restoration complete.');
}

// ==========================================
// 3. GENERIC BACKUP & RESTORE BLOCKS
// ==========================================

function appendBackupToGitIgnore(targetDir) {
  const gitIgnorePath = path.join(targetDir, '.gitignore');

  if (!fs.existsSync(gitIgnorePath)) {
    fs.writeFileSync(gitIgnorePath, `${BACKUP_FILENAME}\n`, 'utf-8');
    return;
  }

  try {
    const content = fs.readFileSync(gitIgnorePath, 'utf-8');
    if (!content.includes(BACKUP_FILENAME)) {
      const separator = content.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(gitIgnorePath, `${separator}${BACKUP_FILENAME}\n`, 'utf-8');
      console.log(`💾 Backup: Added "${BACKUP_FILENAME}" to your local .gitignore.`);
    }
  } catch (err) {
    console.warn(`⚠️ Warning: Failed to automatically update .gitignore: ${err.message}`);
  }
}

export function createBackupBlock(targetDir, manifestName, lockfileName) {
  const manifestPath = path.join(targetDir, manifestName);
  const lockfilePath = path.join(targetDir, lockfileName);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No ${manifestName} found. Cannot create a backup.`);
  }

  console.log('💾 Backup: Creating snapshot of local configuration...');

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  let lockfileContent = null;

  if (fs.existsSync(lockfilePath)) {
    lockfileContent = fs.readFileSync(lockfilePath, 'utf-8');
  }

  const backupData = {
    timestamp: new Date().toISOString(),
    manifest: {
      name: manifestName,
      content: manifestContent
    },
    lockfile: {
      name: lockfileName,
      content: lockfileContent
    }
  };

  const backupPath = path.join(targetDir, BACKUP_FILENAME);
  fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2), 'utf-8');

  appendBackupToGitIgnore(targetDir);
  console.log(`💾 Backup: Original configuration successfully saved to: ${BACKUP_FILENAME}`);
}

export function restoreBackupBlock(targetDir, syncCommand) {
  const backupPath = path.join(targetDir, BACKUP_FILENAME);

  if (!fs.existsSync(backupPath)) {
    throw new Error(`No active backup found. Cannot perform rollback (missing "${BACKUP_FILENAME}").`);
  }

  console.log('🔄 Rollback: Restoring project files to original snapshot...');

  try {
    const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));

    fs.writeFileSync(path.join(targetDir, backupData.manifest.name), backupData.manifest.content, 'utf-8');
    console.log(`✅ Rollback: Original ${backupData.manifest.name} restored.`);

    if (backupData.lockfile && backupData.lockfile.content) {
      fs.writeFileSync(path.join(targetDir, backupData.lockfile.name), backupData.lockfile.content, 'utf-8');
      console.log(`✅ Rollback: Original ${backupData.lockfile.name} restored.`);
    }

    if (syncCommand) {
      console.log('📦 Rollback: Synchronizing local environment dependencies...');
      execSync(syncCommand, { cwd: targetDir, stdio: 'inherit' });
    }

    console.log(`🧹 Rollback: Cleaning up backup file: ${BACKUP_FILENAME}`);
    fs.unlinkSync(backupPath);

    console.log('\n============================================================');
    console.log('✅ Rollback completed successfully! Codebase is restored.   ');
    console.log('============================================================\n');

  } catch (err) {
    throw new Error(`Rollback failed during restore process: ${err.message}`);
  }
}

// ==========================================
// 4. RECURSIVE BISECTION BLOCK
// ==========================================

export async function runBisectionBlock(adapter, sandboxPath, packageManager, originalManifest, groups, options, safeGroups = [], blockedGroups = []) {
  if (groups.length === 0) {
    return { safeGroups, blockedGroups };
  }

  if (groups.length === 1) {
    const activeGroup = groups[0];
    console.log(`❌ Isolation: Testing single group [${activeGroup.id}]...`);
    
    const result = await adapter.validate(sandboxPath, packageManager, originalManifest, [activeGroup], options);
    
    if (result.passed) {
      safeGroups.push(activeGroup);
    } else {
      console.log(`❌ Isolated Failure: [${activeGroup.id}] failed during Tier ${result.tier}.`);
      blockedGroups.push({
        group: activeGroup,
        tier: result.tier,
        error: result.error
      });
    }
    return { safeGroups, blockedGroups };
  }

  const mid = Math.floor(groups.length / 2);
  const leftHalf = groups.slice(0, mid);
  const rightHalf = groups.slice(mid);

  console.log(`🧪 Bisecting: Splitting ${groups.length} groups into subsets of ${leftHalf.length} and ${rightHalf.length}...`);

  console.log(`🧪 Testing Left Subset (${leftHalf.map(g => g.id).join(', ')})...`);
  const leftResult = await adapter.validate(sandboxPath, packageManager, originalManifest, leftHalf, options);

  if (leftResult.passed) {
    console.log('✅ Left Subset passed. All upgrades in this group are safe.');
    leftHalf.forEach(group => safeGroups.push(group));
  } else {
    console.log('❌ Left Subset failed. Recursively narrow down failures...');
    await runBisectionBlock(adapter, sandboxPath, packageManager, originalManifest, leftHalf, options, safeGroups, blockedGroups);
  }

  console.log(`🧪 Testing Right Subset (${rightHalf.map(g => g.id).join(', ')})...`);
  const rightResult = await adapter.validate(sandboxPath, packageManager, originalManifest, rightHalf, options);

  if (rightResult.passed) {
    console.log('✅ Right Subset passed. All upgrades in this group are safe.');
    rightHalf.forEach(group => safeGroups.push(group));
  } else {
    console.log('❌ Right Subset failed. Recursively narrow down failures...');
    await runBisectionBlock(adapter, sandboxPath, packageManager, originalManifest, rightHalf, options, safeGroups, blockedGroups);
  }

  return { safeGroups, blockedGroups };
}

// ==========================================
// 5. PRESENTATION & SMART DIAGNOSTIC BLOCK
// ==========================================

export function extractMeaningfulErrors(rawLog, maxLines = 15) {
  if (!rawLog || typeof rawLog !== 'string') {
    return 'No diagnostic output produced.';
  }

  const cleanLog = rawLog.replace(/\r\n/g, '\n').replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  const lines = cleanLog.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0);

  if (lines.length === 0) {
    return 'No diagnostic output produced.';
  }

  const errorRegex = /(error:|fatal:|failed to compile|cannot find module|module not found|can't resolve|type error|syntaxerror|referenceerror|typeerror|ts\d{4,5}|error ts|\(postcss\)|\bfailed\b|command failed|cannot resolve)/i;
  const noiseRegex = /^(▲ Next\.js|- Environments:|✓ Running next\.config|Creating an optimized production build|info\s+-|ready\s+-|wait\s+-)/i;

  const errorIndices = [];
  lines.forEach((line, idx) => {
    if (errorRegex.test(line) && !noiseRegex.test(line)) {
      errorIndices.push(idx);
    }
  });

  if (errorIndices.length > 0) {
    const primaryIdx = errorIndices[0];
    const start = Math.max(0, primaryIdx - 1);
    const end = Math.min(lines.length, start + maxLines);
    return lines.slice(start, end).join('\n');
  }

  return lines.slice(-maxLines).join('\n');
}

function formatErrorLog(error) {
  if (!error) return '      | No diagnostic data available.';
  const meaningful = extractMeaningfulErrors(error, 6);
  return meaningful
    .split('\n')
    .map(line => `      | ${line}`)
    .join('\n');
}

/**
 * Generates and writes pure JSON report to stdout
 */
export function generateJsonReport(targetDir, safePackages = [], blockedGroups = [], detectedIssues = [], options = {}, env = {}) {
  const totalScanned = safePackages.length + blockedGroups.reduce((acc, g) => acc + (g.group?.packages?.length || 1), 0);

  const jsonReport = {
    timestamp: new Date().toISOString(),
    targetDirectory: targetDir,
    projectStack: env.projectStack || 'nodejs',
    packageManager: env.packageManager || 'npm',
    scope: env.scope || 'FULL',
    success: blockedGroups.length === 0,
    summary: {
      totalScanned,
      safe: safePackages.length,
      blocked: blockedGroups.length,
      deprecatedWarnings: detectedIssues.length
    },
    safeUpgrades: safePackages.map(pkg => ({
      name: pkg.name,
      declaredRange: pkg.declaredRange,
      latestVersion: pkg.latestVersion,
      updateType: pkg.updateType
    })),
    blockedUpgrades: blockedGroups.map(block => ({
      groupId: block.group?.id || 'unknown',
      packages: (block.group?.packages || []).map(p => ({
        name: p.name,
        declaredRange: p.declaredRange,
        latestVersion: p.latestVersion
      })),
      tier: block.tier,
      error: extractMeaningfulErrors(block.error, 25)
    })),
    deprecatedApiWarnings: detectedIssues.map(issue => ({
      file: issue.file,
      lineNum: issue.lineNum,
      codeLine: issue.codeLine,
      message: issue.message,
      packageName: issue.packageName
    }))
  };

  process.stdout.write(JSON.stringify(jsonReport, null, 2) + '\n');
  return jsonReport;
}

export function generateReportBlock(targetDir, safePackages = [], blockedGroups = [], detectedIssues = [], options = {}, env = {}) {
  // If JSON output mode is requested, emit clean JSON to stdout
  if (options.json) {
    generateJsonReport(targetDir, safePackages, blockedGroups, detectedIssues, options, env);
  } else {
    // Console Printing
    console.log('\n============================================================');
    console.log('                  OPTIMIZATION FINAL REPORT                 ');
    console.log('============================================================');
    
    console.log(`\n✅ SAFE TO UPGRADE (${safePackages.length} packages verified):`);
    if (safePackages.length > 0) {
      safePackages.forEach(pkg => {
        console.log(`  - [${pkg.updateType.toUpperCase()}] ${pkg.name}: ${pkg.declaredRange} ──► ${pkg.latestVersion}`);
      });
    } else {
      console.log('  (None)');
    }

    console.log(`\n❌ BLOCKED UPGRADES (${blockedGroups.length} groups blocked):`);
    if (blockedGroups.length > 0) {
      blockedGroups.forEach(block => {
        console.log(`  - Group:   [${block.group.id}]`);
        console.log(`    Failure: Failed during Tier ${block.tier}`);
        console.log(`    Diagnostics:\n${formatErrorLog(block.error)}\n`);
      });
    } else {
      console.log('  (None)');
    }

    if (detectedIssues.length > 0) {
      console.log(`\n⚠️ DEPRECATED API CALLS DETECTED IN YOUR CODE (${detectedIssues.length} issues):`);
      detectedIssues.forEach(issue => {
        console.log(`  - File:    ${issue.file} (Line ${issue.lineNum}) [Source: ${issue.packageName}]`);
        console.log(`    Code:    ${issue.codeLine}`);
        console.log(`    Warning: ${issue.message}\n`);
      });
    }
  }

  // Markdown File Generation (Always writes to targetDir)
  if (!options.json) {
    console.log('📝 Generating local markdown report file...');
  }
  const markdownPath = path.join(targetDir, 'COMPAT_REPORT.md');
  
  let mdContent = `# Dependency Optimization Report\n\n`;
  mdContent += `Generated on: ${new Date().toUTCString()}\n`;
  mdContent += `Package Manager: **${(env.packageManager || 'npm').toUpperCase()}**\n`;
  mdContent += `Upgrade Scope: **${(env.scope || 'FULL').toUpperCase()}**\n\n`;

  mdContent += `## Summary\n`;
  mdContent += `* **Safe Upgrades:** ${safePackages.length}\n`;
  mdContent += `* **Blocked Upgrades:** ${blockedGroups.length}\n`;
  mdContent += `* **Deprecated API Warnings:** ${detectedIssues.length}\n\n`;

  if (safePackages.length === 0 && blockedGroups.length === 0 && detectedIssues.length === 0) {
    mdContent += `🎉 **All project dependencies are 100% up to date and mutually compatible!**\n\n`;
  }

  mdContent += `## ✅ Verified Safe Upgrades\n`;
  if (safePackages.length > 0) {
    mdContent += `The following upgrades compiled, built, and passed all test suites successfully:\n\n`;
    mdContent += `| Package | Current Range | Target Version | Update Type |\n`;
    mdContent += `| :--- | :--- | :--- | :--- |\n`;
    safePackages.forEach(pkg => {
      mdContent += `| \`${pkg.name}\` | \`${pkg.declaredRange}\` | \`${pkg.latestVersion}\` | **${pkg.updateType.toUpperCase()}** |\n`;
    });
  } else {
    mdContent += `*(None)*\n`;
  }
  mdContent += `\n`;

  mdContent += `## ❌ Blocked Upgrades\n`;
  if (blockedGroups.length > 0) {
    mdContent += `These packages failed validation checks and must be reviewed manually:\n\n`;
    blockedGroups.forEach(block => {
      mdContent += `### Group: \`${block.group.id}\`\n`;
      mdContent += `* **Failure Layer:** Tier ${block.tier}\n`;
      mdContent += `* **Diagnostics:**\n\n\`\`\`text\n${extractMeaningfulErrors(block.error, 15)}\n\`\`\`\n\n`;
    });
  } else {
    mdContent += `*(None)*\n`;
  }
  mdContent += `\n`;

  mdContent += `## ⚠️ Deprecated API Call Detections\n`;
  if (detectedIssues.length > 0) {
    mdContent += `The following lines of code invoke deprecated or removed APIs in the successfully upgraded packages:\n\n`;
    detectedIssues.forEach(issue => {
      mdContent += `* **File:** \`${issue.file}\` (Line ${issue.lineNum}) [Library: \`${issue.packageName}\`]\n`;
      mdContent += `  * **Code:** \`${issue.codeLine}\`\n`;
      mdContent += `  * **Warning:** ${issue.message}\n\n`;
    });
  } else {
    mdContent += `*(None. Code matches upgrade deprecation patterns cleanly.)*\n`;
  }

  try {
    fs.writeFileSync(markdownPath, mdContent, 'utf-8');
    if (!options.json) {
      console.log(`💾 Report successfully saved to: ${markdownPath}`);
    }
  } catch (err) {
    if (!options.json) {
      console.warn(`⚠️ Warning: Failed to write COMPAT_REPORT.md: ${err.message}`);
    }
  }

  if (!options.json) {
    console.log('\n============================================================');
  }
}