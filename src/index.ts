import 'dotenv/config';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { ClaudeCodeWorker } from './workers/claudeCode.js';
import { FileSessionStore } from './sessions/sessionStore.js';

const config = loadConfig();
const worker = new ClaudeCodeWorker();
const app = createApp(config, worker);

// Mark any sessions that were running when the server last stopped
const store = new FileSessionStore(config.dataDir);
await store.markAbortedOnStartup();

app.listen(config.port, config.bind, () => {
  console.log(`agent-firewall listening on ${config.bind}:${config.port}`);
});
