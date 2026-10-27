#!/usr/bin/env node

import { runOptimizer } from '../src/index.js';

// Global crash handlers to report unexpected errors gracefully without swallowing
process.on('uncaughtException', (err) => {
  console.error('\n❌ Uncaught Exception:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('\n❌ Unhandled Rejection:', reason?.message || String(reason));
  process.exit(1);
});

// Parse raw CLI arguments manually
function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    sandbox: args.includes('--sandbox'),
    restore: args.includes('--restore'),
    skipTests: args.includes('--skip-tests'),
    ignoreScripts: args.includes('--ignore-scripts'),
    patchOnly: args.includes('--patch-only'),
    minorOnly: args.includes('--minor-only'),
    json: args.includes('--json'),
    failOnBlocked: args.includes('--fail-on-blocked'),
    help: args.includes('--help') || args.includes('-h')
  };
}

const options = parseArgs();

if (options.help) {
  console.log(`
compat-core - Autonomous Dependency Compatibility Engine

Usage:
  npx compat-core [options]

Options:
  --apply           Apply verified upgrades to manifest and lockfile
  --restore         Undo the last applied upgrades, restoring original files
  --sandbox         Run verification inside an OS temp directory instead of Git branching
  --skip-tests      Skip execution of test suites (Tier D)
  --ignore-scripts  Ignore lifecycle scripts during dependency installation
  -h, --help        Show this help message
  `);
  process.exit(0);
}

// Start the optimizer coordination logic
runOptimizer(options).then((result) => {
  if (options.failOnBlocked && (result?.hasBlocked || !result?.success)) {
    console.error(`\n🚨 CI Gate Failed: Exiting with code 1 due to --fail-on-blocked flag (${result?.blockedCount || 0} blocked upgrades).`);
    process.exit(1);
  }
  process.exit(0); 
}).catch((err) => {
  console.error('\n❌ Fatal execution error:', err.stack || err);
  process.exit(1);
});