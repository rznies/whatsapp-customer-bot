import app from './app.js';
import { startFollowupCron } from './jobs/followup.cron.js';

const PORT = process.env.PORT || 3000;

startFollowupCron();

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
