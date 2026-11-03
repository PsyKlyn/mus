const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const root = __dirname;

app.disable('x-powered-by');
app.use(express.static(root, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js')) res.type('application/javascript');
    if (filePath.endsWith('.css')) res.type('text/css');
  }
}));

app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

app.get('*', (_req, res) => res.sendFile(path.join(root, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QUE web service listening on ${PORT}`);
});
