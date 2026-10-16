'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const file of ['index.html', 'login.html', 'signup.html', 'logo.png', 'logo-mascot.webp']) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}

fs.cpSync(path.join(root, 'public'), path.join(output, 'public'), { recursive: true });
fs.cpSync(path.join(root, 'public', 'css'), path.join(output, 'css'), { recursive: true });
fs.cpSync(path.join(root, 'public', 'js'), path.join(output, 'js'), { recursive: true });
fs.cpSync(path.join(root, 'public', 'html'), path.join(output, 'html'), { recursive: true });

for (const file of fs.readdirSync(path.join(root, 'public', 'html'))) {
  if (file.endsWith('.html')) {
    fs.copyFileSync(path.join(root, 'public', 'html', file), path.join(output, file));
  }
}
