/**
 * Parses a semver string (e.g., "18.2.0-rc.1") into a structured object.
 */
function parseSemver(vStr) {
  if (!vStr) return { major: 0, minor: 0, patch: 0, prerelease: null };
  
  const clean = String(vStr).trim().replace(/^[vV=]/, '');
  const [main, prerelease] = clean.split('-');
  const parts = main.split('.').map(p => {
    const n = parseInt(p, 10);
    return isNaN(n) ? 0 : n;
  });

  return {
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
    prerelease: prerelease ? prerelease.trim() : null
  };
}

/**
 * Compares two semver objects: returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
 */
function compareSemver(v1, v2) {
  if (v1.major !== v2.major) return v1.major > v2.major ? 1 : -1;
  if (v1.minor !== v2.minor) return v1.minor > v2.minor ? 1 : -1;
  if (v1.patch !== v2.patch) return v1.patch > v2.patch ? 1 : -1;

  // Non-prerelease versions have higher precedence than prereleases (1.0.0 > 1.0.0-alpha)
  if (!v1.prerelease && v2.prerelease) return 1;
  if (v1.prerelease && !v2.prerelease) return -1;
  if (v1.prerelease && v2.prerelease) {
    return v1.prerelease.localeCompare(v2.prerelease, undefined, { numeric: true });
  }

  return 0;
}

/**
 * Evaluates a single primitive comparison (e.g. '>=18.0.0', '<19.0.0', '=1.0.0')
 */
function evaluatePrimitive(versionObj, primitive) {
  const match = primitive.trim().match(/^([><=!]=?)\s*([0-9a-zA-Z.-]+)$/);
  if (!match) {
    const targetObj = parseSemver(primitive);
    return compareSemver(versionObj, targetObj) === 0;
  }

  const op = match[1];
  const targetObj = parseSemver(match[2]);
  const cmp = compareSemver(versionObj, targetObj);

  switch (op) {
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '=':
    case '==': return cmp === 0;
    case '!=': return cmp !== 0;
    default: return true;
  }
}

/**
 * Expands high-level semver operators (~, ^, x, *, etc.) into primitive comparisons (>=, <)
 */
function expandConstraint(clause) {
  const trimmed = clause.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'latest' || trimmed.toLowerCase() === 'x') {
    return ['>=0.0.0'];
  }

  // Caret ranges: ^1.2.3, ^0.2.3, ^0.0.3, ^18
  if (trimmed.startsWith('^')) {
    const raw = trimmed.slice(1).trim();
    const v = parseSemver(raw);
    if (v.major > 0) {
      return [`>=${v.major}.${v.minor}.${v.patch}`, `<${v.major + 1}.0.0`];
    } else if (v.minor > 0) {
      return [`>=0.${v.minor}.${v.patch}`, `<0.${v.minor + 1}.0`];
    } else {
      return [`>=0.0.${v.patch}`, `<0.0.${v.patch + 1}`];
    }
  }

  // Tilde ranges: ~1.2.3, ~1.2, ~1
  if (trimmed.startsWith('~')) {
    const raw = trimmed.slice(1).trim();
    const parts = raw.split('.');
    const v = parseSemver(raw);
    if (parts.length === 1) {
      return [`>=${v.major}.0.0`, `<${v.major + 1}.0.0`];
    } else {
      return [`>=${v.major}.${v.minor}.${v.patch}`, `<${v.major}.${v.minor + 1}.0`];
    }
  }

  // Wildcards: 18.x, 18.*, 18.2.x, 18.2.*
  if (/^[0-9]+(\.[0-9]+)?\.([xX*])$/.test(trimmed)) {
    const parts = trimmed.split('.');
    const major = parseInt(parts[0], 10);
    if (parts.length === 2 || parts[1] === '*' || parts[1].toLowerCase() === 'x') {
      return [`>=${major}.0.0`, `<${major + 1}.0.0`];
    } else {
      const minor = parseInt(parts[1], 10);
      return [`>=${major}.${minor}.0`, `<${major}.${minor + 1}.0`];
    }
  }

  // Already a primitive (e.g. >=1.0.0, <=2.0.0, >1.0.0, <2.0.0, =1.0.0, 1.0.0)
  return [trimmed];
}

/**
 * Checks if a version satisfies a complex semver range (supports space-AND, ||-OR, hyphen ranges, wildcards)
 * @param {string} version (e.g. "19.2.8")
 * @param {string} range (e.g. ">=16.8.0 || ^17.0.0")
 * @returns {boolean}
 */
export function satisfies(version, range) {
  if (!range || range === '*' || range === 'latest') return true;

  // 1. Convert hyphen ranges "1.0.0 - 2.0.0" -> ">=1.0.0 <=2.0.0"
  let normalized = range.replace(/([0-9a-zA-Z.-]+)\s+-\s+([0-9a-zA-Z.-]+)/g, '>=$1 <=$2');

  // 2. Normalize spaces after comparator operators: ">= 18.0.0" -> ">=18.0.0"
  normalized = normalized.replace(/([><=!]=?)\s+([0-9a-zA-Z.-]+)/g, '$1$2');

  const parsedTarget = parseSemver(version);

  // 3. Evaluate OR sets ("||")
  const orSets = normalized.split('||');

  return orSets.some(orSet => {
    // 4. Split by whitespace for AND clauses
    const andClauses = orSet.trim().split(/\s+/).filter(Boolean);
    
    return andClauses.every(clause => {
      const primitives = expandConstraint(clause);
      return primitives.every(prim => evaluatePrimitive(parsedTarget, prim));
    });
  });
}

/**
 * Groups highly-coupled packages into Atomic Units so they are never upgraded in isolation.
 * @param {Array<object>} upgrades 
 * @returns {Array<object>}
 */
export function groupAtomicUnits(upgrades) {
  const atomicCoupledPairs = [
    ['react', 'react-dom'],
    ['@types/react', '@types/react-dom'],
    ['@nestjs/core', '@nestjs/common'],
    ['@trpc/client', '@trpc/server', '@trpc/react-query'],
    ['tailwindcss', 'postcss', 'autoprefixer'],
    ['@babel/core', '@babel/preset-env'],
    ['eslint', '@typescript-eslint/parser', '@typescript-eslint/eslint-plugin']
  ];

  const atomicGroups = [];
  const assigned = new Set();

  upgrades.forEach(pkg => {
    if (assigned.has(pkg.name)) return;
    const matchedPair = atomicCoupledPairs.find(pair => pair.includes(pkg.name));
    
    if (matchedPair) {
      const group = [];
      matchedPair.forEach(name => {
        const found = upgrades.find(u => u.name === name);
        if (found) {
          group.push(found);
          assigned.add(name);
        }
      });
      if (group.length > 0) {
        atomicGroups.push({
          id: group.map(g => g.name).join('+'),
          packages: group,
          isAtomic: group.length > 1
        });
      }
    } else {
      atomicGroups.push({
        id: pkg.name,
        packages: [pkg],
        isAtomic: false
      });
      assigned.add(pkg.name);
    }
  });

  return atomicGroups;
}

/**
 * Analyzes peer dependency constraints across proposed updates
 * @param {Array<object>} upgrades 
 * @returns {{ conflicts: Array, atomicGroups: Array }}
 */
export function solve(upgrades) {
  const proposedVersions = {};
  upgrades.forEach(pkg => { proposedVersions[pkg.name] = pkg.latestVersion; });
  const conflicts = [];

  upgrades.forEach(pkg => {
    const peers = pkg.peerDependencies || {};
    Object.keys(peers).forEach(peerName => {
      const requiredRange = peers[peerName];
      const proposedVersion = proposedVersions[peerName];

      if (proposedVersion) {
        const isCompatible = satisfies(proposedVersion, requiredRange);
        if (!isCompatible) {
          conflicts.push({
            package: pkg.name,
            peer: peerName,
            requiredRange,
            proposedVersion,
            message: `Package "${pkg.name}" requires peer "${peerName}@${requiredRange}" but proposed version is "${proposedVersion}".`
          });
        }
      }
    });
  });

  return { conflicts, atomicGroups: groupAtomicUnits(upgrades) };
}