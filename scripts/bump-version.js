#!/usr/bin/env node
// Auto-increments package.json's patch/build number every time
// build-extension.bat runs, so each generated .vsix carries a unique,
// monotonically increasing version with no manual bookkeeping. This is also
// what shows up as the "vX.Y.Z" badge on the main Object Spy panel
// (ObjectSpyPanel reads it straight from context.extension.packageJSON).
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const raw = fs.readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(raw);

const parts = pkg.version.split('.').map((n) => parseInt(n, 10) || 0);
while (parts.length < 3) {
  parts.push(0);
}
parts[2] += 1; // bump the patch/build component only
pkg.version = parts.slice(0, 3).join('.');

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`Version bumped to ${pkg.version}`);
