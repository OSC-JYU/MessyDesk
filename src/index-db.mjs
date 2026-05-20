import nats from './queue.mjs';
import queueDb from './queue-db.mjs';

// Patch the shared queue singleton before booting the normal server entrypoint.
Object.assign(nats, queueDb);

await import('./index.mjs');
