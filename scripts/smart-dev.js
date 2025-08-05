#!/usr/bin/env node

// Clean up any zombie processes and start dev
const { execSync } = require('child_process');

// Kill any existing coachartie processes
try {
  execSync("pkill -f 'coachartie2.*tsx' || true", { stdio: 'ignore' });
  execSync("pkill -f 'coachartie2.*node' || true", { stdio: 'ignore' });
} catch (e) {
  // Ignore errors - processes might not exist
}

// Start turbo dev
execSync('turbo run dev', { stdio: 'inherit' });