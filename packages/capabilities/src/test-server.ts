import express from 'express';

const app = express();
const PORT = 8080;

app.get('/test', (req, res) => res.send('OK'));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Test server listening on ${PORT}`);
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    console.log(`Server bound to ${addr.address}:${addr.port}`);
  }
});

server.on('error', (err: any) => {
  console.error('Server error:', err);
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
  }
});

// Test the server after 1 second
setTimeout(() => {
  console.log('Testing server...');
  fetch(`http://localhost:${PORT}/test`)
    .then(res => res.text())
    .then(text => console.log('Server response:', text))
    .catch(err => console.error('Test failed:', err));
}, 1000);

// Keep process alive
process.stdin.resume();