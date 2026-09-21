import fs from 'fs';
import path from 'path';

const CONCURRENCY_LIMIT = 10;

/**
 * Executes asynchronous tasks across an array with a maximum concurrency limit.
 * Zero external dependencies.
 * @param {Array<any>} items 
 * @param {number} limit 
 * @param {Function} workerFn 
 * @returns {Promise<Array<any>>}
 */
async function mapConcurrent(items, limit, workerFn) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let currentIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await workerFn(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Extracts clean semver from a declared range (e.g., "^18.2.0" -> "18.2.0")
 */
function cleanSemverRange(range) {
  if (!range) return '0.0.0';
  return range.replace(/^[~^>=<|\s]+/, '').split('||')[0].trim();
}

/**
 * Categorizes the type of update between current and latest versions
 */
function determineUpdateType(current, latest) {
  if (!current || !latest || current === latest) return 'none';

  const currParts = current.split('-')[0].split('.').map(Number);
  const lateParts = latest.split('-')[0].split('.').map(Number);

  if (currParts.length < 3 || lateParts.length < 3 || isNaN(currParts[0]) || isNaN(lateParts[0])) {
    return 'none';
  }

  if (lateParts[0] > currParts[0]) return 'major';
  if (lateParts[1] > currParts[1]) return 'minor';
  if (lateParts[2] > currParts[2]) return 'patch';

  return 'none';
}

/**
 * Fetches URL with timeout and exponential backoff retry on HTTP 429 / 5xx
 */
async function fetchWithRetry(url, options = {}, retries = 2, delayMs = 500) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);

    if (res.status === 429 || (res.status >= 500 && res.status <= 504)) {
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return fetchWithRetry(url, options, retries - 1, delayMs * 2);
      }
    }
    return res;
  } catch (err) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return fetchWithRetry(url, options, retries - 1, delayMs * 2);
    }
    throw err;
  }
}

/**
 * Fetches registry metadata for a single package
 */
async function fetchPackageUpdate(name, declaredRange) {
  const encodedName = name.startsWith('@') 
    ? `${name.split('/')[0]}%2F${name.split('/')[1]}` 
    : name;

  const url = `https://registry.npmjs.org/${encodedName}`;
  const currentClean = cleanSemverRange(declaredRange);

  try {
    const res = await fetchWithRetry(url, {
      headers: {
        'Accept': 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
        'User-Agent': 'compat-core/1.0.0 (Node.js)'
      }
    });
    
    if (!res.ok) {
      throw new Error(`Registry returned HTTP ${res.status}`);
    }

    const data = await res.json();
    const latestVersion = data['dist-tags']?.latest;

    if (!latestVersion) {
      throw new Error('No latest tag found in registry');
    }

    const latestManifest = data.versions?.[latestVersion] || {};
    const peerDependencies = latestManifest.peerDependencies || {};

    const updateType = determineUpdateType(currentClean, latestVersion);

    return {
      name,
      declaredRange,
      currentClean,
      latestVersion,
      updateType,
      peerDependencies,
      error: null
    };
  } catch (err) {
    return {
      name,
      declaredRange,
      currentClean,
      latestVersion: null,
      updateType: 'none',
      peerDependencies: {},
      error: err.message
    };
  }
}

/**
 * Scans all dependencies inside package.json and finds updates using batched concurrent requests
 * @param {string} targetDir 
 * @returns {Promise<{ upgrades: Array, errors: Array }>}
 */
export async function scanRegistryUpdates(targetDir) {
  const packageJsonPath = path.join(targetDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

  const deps = packageJson.dependencies || {};
  const devDeps = packageJson.devDependencies || {};

  const depEntries = [
    ...Object.keys(deps).map(name => ({ name, range: deps[name], isDev: false })),
    ...Object.keys(devDeps).map(name => ({ name, range: devDeps[name], isDev: true }))
  ];

  console.log(`📡 Querying registry for ${depEntries.length} dependencies (Max concurrency: ${CONCURRENCY_LIMIT})...`);

  const results = await mapConcurrent(depEntries, CONCURRENCY_LIMIT, async ({ name, range }) => {
    return await fetchPackageUpdate(name, range);
  });

  return {
    totalScanned: allResults.length,
    upToDate: allResults.filter(item => item.updateType === 'none' && !item.error).length,
    upgrades: allResults.filter(item => item.updateType !== 'none' && !item.error),
    errors: allResults.filter(item => item.error)
  };
}