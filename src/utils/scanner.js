import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

// Resolve the absolute path of this active scanner.js file to prevent self-matching
const __filename = fileURLToPath(import.meta.url);

/**
 * Dynamically loads the TypeScript compiler library from the target project's node_modules
 */
async function loadTypeScript(targetDir) {
  const localTsPath = path.join(targetDir, 'node_modules', 'typescript', 'lib', 'typescript.js');
  if (!fs.existsSync(localTsPath)) return null;
  try {
    const tsModule = await import(pathToFileURL(localTsPath).href);
    return tsModule.default || tsModule;
  } catch {
    return null;
  }
}

/**
 * Recursively scans a directory for JS/TS source code files
 */
function findSourceFiles(dir, excludeList, fileList = []) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return fileList;
  }

  files.forEach(file => {
    const filePath = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    if (stat.isDirectory()) {
      if (!excludeList.includes(file)) {
        findSourceFiles(filePath, excludeList, fileList);
      }
    } else {
      if (filePath === __filename) {
        return; // Skip our own file
      }
      const ext = path.extname(file);
      if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
        fileList.push(filePath);
      }
    }
  });

  return fileList;
}

/**
 * Runs the static compiler-level code inspection for JSDoc @deprecated tags
 * @param {string} targetDir 
 * @param {Array<object>} upgradedPackages List of successfully upgraded packages
 * @param {Array<string>} excludeList List of dynamic excludes from .gitignore
 * @returns {Promise<Array<object>>} List of detected deprecation warnings
 */
export async function runStaticScanner(targetDir, upgradedPackages, excludeList) {
  const ts = await loadTypeScript(targetDir);

  if (!ts) {
    console.log('\n⚠️  TypeScript compiler not found in project node_modules.');
    console.log('⏭  Skipping deep API deprecation scan.');
    return [];
  }

  console.log(`\n🔍 Static Scanner: Initiating compiler-level analysis (TS ${ts.version})...`);

  const activeExcludes = excludeList && excludeList.length > 0 
    ? excludeList 
    : ['node_modules', '.git', 'coverage', 'compat-sandbox-'];

  const sourceFiles = findSourceFiles(targetDir, activeExcludes);

  console.log(`🔍 Static Scanner: Loading ${sourceFiles.length} source files into TS memory compiler...`);

  // Create an in-memory compiler program utilizing the project's node_modules types
  const program = ts.createProgram(sourceFiles, {
    allowJs: true,
    checkJs: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    jsx: ts.JsxEmit.React // Ensure JSX syntax is parsed properly
  });

  const checker = program.getTypeChecker();
  const detectedIssues = [];
  const uniqueIssues = new Set(); // Prevent duplicate warnings on the exact same line

  // Traverse the AST of each source file
  for (const sourceFile of program.getSourceFiles()) {
    // Skip external declarations or packages
    if (sourceFile.isDeclarationFile || sourceFile.fileName.includes('node_modules')) {
      continue;
    }

    const relativePath = path.relative(targetDir, sourceFile.fileName);

    function visit(node) {
      // Resolve the original type declaration symbol of the active AST node
      const symbol = checker.getSymbolAtLocation(node);
      
      if (symbol) {
        const jsDocTags = symbol.getJsDocTags();
        const deprecationTag = jsDocTags.find(tag => tag.name === 'deprecated');

        if (deprecationTag) {
          // Extract the author's descriptive deprecated text
          const rawMessage = deprecationTag.text 
            ? (Array.isArray(deprecationTag.text)
                ? deprecationTag.text.map(t => t.text).join('')
                : deprecationTag.text)
            : "This API is marked as deprecated by the library author.";
          
          const cleanMessage = rawMessage.trim().replace(/\r?\n/g, ' ');

          // Extract position parameters
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const lineNum = line + 1;

          // Deduplicate issues pointing to the same line/message
          const uniqueKey = `${relativePath}:${lineNum}:${cleanMessage}`;

          if (!uniqueIssues.has(uniqueKey)) {
            uniqueIssues.add(uniqueKey);

            // Trace the absolute file location where the type was declared
            let originPackage = 'unknown';
            if (symbol.declarations && symbol.declarations[0]) {
              const originFile = symbol.declarations[0].getSourceFile().fileName;
              const match = originFile.match(/node_modules\/([^/]+)/);
              if (match) {
                originPackage = match[1];
              }
            }

            // Check if the originating package matches one of our successfully upgraded packages
            const isUpgraded = upgradedPackages.some(pkg => pkg.name === originPackage);

            if (isUpgraded || originPackage === 'typescript') {
              detectedIssues.push({
                file: relativePath,
                lineNum,
                codeLine: node.getText(),
                message: cleanMessage,
                packageName: originPackage
              });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return detectedIssues;
}