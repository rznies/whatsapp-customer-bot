import express from 'express';
import path from 'path';
import webhookRouter from './routes/webhook.js';
import dashboardRouter from './routes/dashboard.js';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/webhook', webhookRouter);

// Serve built React dashboard in production
const dashboardDistPath = path.resolve(__dirname, '../dashboard/dist');
app.use('/dashboard', express.static(dashboardDistPath));

// Mount dashboard API router under /dashboard/api
app.use('/dashboard/api', dashboardRouter);

// Catch-all route to serve the built dashboard index.html for React Router / SPA fallback
app.get('/dashboard/*', (req, res) => {
  res.sendFile(path.join(dashboardDistPath, 'index.html'));
});

export default app;
