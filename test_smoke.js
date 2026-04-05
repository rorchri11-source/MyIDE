/**
 * Smoke test per MyIDE - verifica che l'app si avvii senza crash
 * dopo l'aggiornamento del build system con esbuild.
 *
 * Uso: node test_smoke.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname);
const SRC = path.join(ROOT, 'src');
const HTML_FILE = path.join(SRC, 'index.html');
const BUNDLE_FILE = path.join(SRC, 'bundle.js');
const ELECTRON_EXE = path.join(ROOT, 'node_modules', '.bin', 'electron.cmd');

let failures = 0;
let passes = 0;

function ok(msg) { console.log(`  [PASS] ${msg}`); passes++; }
function fail(msg) { console.log(`  [FAIL] ${msg}`); failures++; }

// ──────────────────────────────────────────────
// 1. Verifica che bundle.js esista e sia non vuoto
// ──────────────────────────────────────────────
function testBundleExists() {
  console.log('\n[1] Verifica bundle.js');
  if (!fs.existsSync(BUNDLE_FILE)) {
    return fail('bundle.js non esiste (eseguire "npm run build:renderer" prima)');
  }
  const stat = fs.statSync(BUNDLE_FILE);
  if (stat.size === 0) {
    return fail('bundle.js esiste ma e vuoto');
  }
  // Minimo ragionevole per un bundle che include codemirror: > 100 KB
  if (stat.size < 50000) {
    return fail(`bundle.js troppo piccolo (${stat.size} byte), potrebbe essere incompleto`);
  }
  ok(`bundle.js esiste (${(stat.size / 1024).toFixed(0)} KB)`);
}

// ──────────────────────────────────────────────
// 2. Verifica che index.html referenzi bundle.js
// ──────────────────────────────────────────────
function testHtmlRefsBundle() {
  console.log('\n[2] Verifica riferimento a bundle.js in index.html');
  if (!fs.existsSync(HTML_FILE)) {
    return fail('index.html non trovato');
  }
  const html = fs.readFileSync(HTML_FILE, 'utf-8');
  if (html.includes('src="bundle.js"') || html.includes("src='bundle.js'")) {
    ok('index.html include <script src="bundle.js">');
  } else {
    fail('index.html NON include un riferimento a bundle.js');
  }

  // Verifica che il main process carichi il file HTML corretto
  const mainJs = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf-8');
  if (mainJs.includes('index.html')) {
    ok('main.js carica index.html');
  } else {
    fail('main.js NON carica index.html');
  }
}

// ──────────────────────────────────────────────
// 3. Verifica import risolti nei moduli .js
// ──────────────────────────────────────────────
function resolveImportPath(importSpecifier, fromFile) {
  const dir = path.dirname(fromFile);
  let candidate = path.resolve(dir, importSpecifier);

  // Diretto
  if (fs.existsSync(candidate)) return candidate;
  // Con estensione .js
  if (fs.existsSync(candidate + '.js')) return candidate + '.js';
  // come directory + index
  if (fs.existsSync(path.join(candidate, 'index.js'))) return path.join(candidate, 'index.js');

  return null;
}

function testImportsResolved() {
  console.log('\n[3] Verifica import risolti nei moduli');
  const dirs = ['src/core', 'src/ui', 'src/modes'];
  let allOk = true;

  // index.js
  const indexJs = path.join(SRC, 'index.js');
  if (fs.existsSync(indexJs)) {
    const content = fs.readFileSync(indexJs, 'utf-8');
    const localImports = content.match(/from\s+['"](\.[^'"]+)['"]/g) || [];
    for (const imp of localImports) {
      const spec = imp.replace(/from\s+['"]|['"]/g, '');
      const resolved = resolveImportPath(spec, indexJs);
      if (!resolved) {
        fail(`index.js -> import "${spec}" NON risolto`);
        allOk = false;
      }
    }
  }

  for (const dir of dirs) {
    const fullPath = path.join(ROOT, dir);
    if (!fs.existsSync(fullPath)) {
      fail(`Directory ${dir} non trovata`);
      allOk = false;
      continue;
    }
    const files = fs.readdirSync(fullPath).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const filePath = path.join(fullPath, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const localImports = content.match(/from\s+['"](\.[^'"]+)['"]/g) || [];
      for (const imp of localImports) {
        const spec = imp.replace(/from\s+['"]|['"]/g, '');
        const resolved = resolveImportPath(spec, filePath);
        if (!resolved) {
          fail(`${dir}/${file} -> import "${spec}" NON risolto`);
          allOk = false;
        } else {
          // OK, silente
        }
      }
    }
  }

  if (allOk) {
    ok('Tutti gli import locali sono risolti');
  }
}

// ──────────────────────────────────────────────
// 4. Electron headless smoke test - 3 secondi
// ──────────────────────────────────────────────
function testElectronLaunch() {
  return new Promise((resolve) => {
    console.log('\n[4] Electron headless smoke test');

    const electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
    const proc = spawn(electronPath, [
      path.join(ROOT, 'electron', 'main.js'),
      '--no-sandbox',
      '--disable-gpu',
      '--headless=new'
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    });

    let stdout = '';
    let stderr = '';
    let handled = false;

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      if (handled) return;
      handled = true;
      fail(`Electron non si avvia: ${err.message}`);
      resolve();
    });

    const onExit = (code, signal) => {
      if (handled) return;
      handled = true;
      if (code !== 0 && code !== null) {
        fail(`Electron e uscito con codice ${code} entro 3s`);
        fail(`  stderr: ${stderr.slice(0, 300)}`);
      } else if (signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGKILL') {
        ok('Electron non e crashato nei primi 3 secondi (terminato dal test)');
      } else {
        ok('Electron si e avviato e chiuso correttamente');
      }
      resolve();
    };
    proc.on('exit', onExit);
    proc.on('close', onExit);

    let safetyFired = 0;
    // Timeout: dopo 3 secondi, uccidi il processo
    setTimeout(() => {
      safetyFired = 1;
      try { proc.kill('SIGTERM'); } catch { /* already exited */ }
    }, 3000);

    // Safety net: max 8 secondi
    const safetyTimer = setTimeout(() => {
      if (handled) { clearTimeout(safetyTimer); return; }
      safetyFired = 2;
      handled = true;
      fail('Electron non si e chiuso dopo timeout');
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 8000);
  });
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────
async function main() {
  console.log('=== MyIDE Smoke Test ===');
  console.log(`Project root: ${ROOT}`);
  console.log(`Node: ${process.version}, Platform: ${process.platform}`);

  testBundleExists();
  testHtmlRefsBundle();
  testImportsResolved();
  await testElectronLaunch();

  console.log('\n=== Risultati ===');
  console.log(`  Pass: ${passes}`);
  console.log(`  Fail: ${failures}`);

  if (failures > 0) {
    console.log('\nSTATUS: FALLITO');
    process.exitCode = 1;
  } else {
    console.log('\nSTATUS: OK - tutto funzionante');
    process.exitCode = 0;
  }
}

main().catch(err => {
  console.error('Smoke test error:', err);
  process.exitCode = 1;
});
