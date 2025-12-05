// index-maintenance.mjs
import Hapi from '@hapi/hapi';
import Inert from '@hapi/inert';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8200;

const init = async () => {
  const server = Hapi.server({
    port: PORT,
    host: '0.0.0.0',
    routes: {
      files: {
        relativeTo: path.join(__dirname)
      }
    }
  });

  await server.register(Inert);

  // Serve static files (e.g., CSS/images for maintenance page)
  server.route({
    method: 'GET',
    path: '/{param*}',
    handler: (request, h) => {
      // Only serve static files if they exist, otherwise serve maintenance page
      const filePath = path.join(__dirname, request.path);
      if (filePath.endsWith('.css') || filePath.endsWith('.js') || filePath.endsWith('.png') || filePath.endsWith('.jpg')) {
        return h.file(request.path).code(200);
      }
      return h.file('maintenance.html').code(503);
    },
    options: {
      auth: false
    }
  });

  await server.start();
  console.log(`Maintenance server running at: ${server.info.uri}`);
};

init().catch((err) => {
  console.error(err);
  process.exit(1);
});