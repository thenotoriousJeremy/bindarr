const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const tmpDb = path.join(os.tmpdir(), `bindarr-rebrand-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const projectRoot = path.join(__dirname, '../../../');

async function waitForServer(port) {
  const url = `http://localhost:${port}/api/health`;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server on port ${port} did not start in time`);
}

async function runTests() {
  const port = '3009';
  
  // Start server as child process
  const server = spawn('node', [path.join(projectRoot, 'backend/src/server.js')], {
    env: {
      ...process.env,
      PORT: port,
      DB_PATH: tmpDb
    }
  });

  // Relay server logs for debugging if needed
  server.stdout.on('data', (data) => {
    // console.log(`[Server] ${data}`);
  });
  server.stderr.on('data', (data) => {
    // console.error(`[Server Error] ${data}`);
  });

  try {
    await waitForServer(port);

    // F1-TC1: Root package.json rebranding
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    assert.ok(pkg.name.includes('bindarr') || pkg.name.includes('pokedexrr'), 'Root package.json name must contain bindarr or pokedexrr');
    assert.ok(pkg.name === 'bindarr-monorepo', 'Root package.json name should be bindarr-monorepo');
    console.log('PASS: F1-TC1');

    // F1-TC2: backend/package.json rebranding
    const bPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'backend/package.json'), 'utf8'));
    assert.strictEqual(bPkg.name, 'bindarr-backend', 'backend/package.json name must be bindarr-backend');
    console.log('PASS: F1-TC2');

    // F1-TC3: frontend/package.json rebranding
    const fPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'frontend/package.json'), 'utf8'));
    assert.strictEqual(fPkg.name, 'bindarr-frontend', 'frontend/package.json name must be bindarr-frontend');
    console.log('PASS: F1-TC3');

    // F1-TC4: Dockerfile rebranding
    const dockerfile = fs.readFileSync(path.join(projectRoot, 'Dockerfile'), 'utf8');
    assert.ok(dockerfile.toLowerCase().includes('bindarr'), 'Dockerfile must reference bindarr');
    console.log('PASS: F1-TC4');

    // F1-TC5: docker-compose.yml rebranding
    const compose = fs.readFileSync(path.join(projectRoot, 'docker-compose.yml'), 'utf8');
    assert.ok(compose.toLowerCase().includes('bindarr'), 'docker-compose.yml must reference bindarr');
    console.log('PASS: F1-TC5');

    // F1-TC6: README.md rebranding
    const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
    assert.ok(readme.includes('Bindarr'), 'README.md must contain Bindarr');
    console.log('PASS: F1-TC6');

    // F1-TC7: .env.example rebranding
    const envExample = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf8');
    assert.ok(envExample.includes('Bindarr') || envExample.includes('bindarr'), '.env.example must reference Bindarr');
    console.log('PASS: F1-TC7');

    // F1-TC8: frontend/index.html title rebranding
    const indexHtml = fs.readFileSync(path.join(projectRoot, 'frontend/index.html'), 'utf8');
    assert.ok(indexHtml.includes('<title>Bindarr</title>'), 'frontend/index.html title must be Bindarr');
    console.log('PASS: F1-TC8');

    // F1-TC9: backend/src/db.js database name rebranding
    const dbFileContent = fs.readFileSync(path.join(projectRoot, 'backend/src/db.js'), 'utf8');
    assert.ok(!dbFileContent.includes('pokedexrr.sqlite'), 'backend/src/db.js must not fallback to pokedexrr.sqlite');
    console.log('PASS: F1-TC9');

    // F1-TC10: GET /api/health API headers contain X-App-Name: Bindarr
    const res = await fetch(`http://localhost:${port}/api/health`);
    assert.strictEqual(res.status, 200, 'Health check should return 200');
    assert.strictEqual(res.headers.get('x-app-name'), 'Bindarr', 'Health check header x-app-name must be Bindarr');
    console.log('PASS: F1-TC10');

  } finally {
    // Kill server immediately to prevent sqlite3 teardown crashes on Windows
    server.kill('SIGKILL');
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch {}
    }
  }
}

runTests()
  .then(() => {
    setTimeout(() => {
      process.exit(0);
    }, 500);
  })
  .catch(err => {
    setTimeout(() => {
      process.exit(1);
    }, 500);
  });
