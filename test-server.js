const express = require('express');
const app = express();

app.get('/test', (req, res) => res.send('OK'));

const server = app.listen(8080, '0.0.0.0', () => {
  console.log('Test server listening on 8080');
  console.log('Server address:', server.address());
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

// Keep the process alive
process.stdin.resume();