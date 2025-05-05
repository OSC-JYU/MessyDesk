import Hapi from '@hapi/hapi';
import Inert from '@hapi/inert';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url';
import Boom from '@hapi/boom';
import Susie from 'susie';

import nats from './queue.mjs';
import Graph from './graph.mjs';
import media from './media.mjs';
import services from './services.mjs';
import nomad from './nomad.mjs';

// Import route modules
import projectRoutes from './routes/projects.mjs';
import serviceRoutes from './routes/services.mjs';
import entityRoutes from './routes/entities.mjs';
import fileRoutes from './routes/files.mjs';
import graphRoutes from './routes/graph.mjs';
import authRoutes from './routes/auth.mjs';
import eventRoutes from './routes/events.mjs';
import nomadRoutes from './routes/nomad.mjs';
import queueRoutes from './routes/queues.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || 'data';
const API_URL = process.env.API_URL || '/';
const AUTH_HEADER = 'mail';
const AUTH_NAME = 'displayname';

const sseClients = new Map();

// Initialize the server
const init = async () => {
	console.log('initing...');
	await media.createDataDir(DATA_DIR);
	await nomad.getStatus();
	await services.loadServiceAdapters();
	await nats.init(services.getServices());
	await Graph.initDB();

	// Create server instance
	const server = Hapi.server({
		port: process.env.PORT || 8200,
		host: '0.0.0.0',
		routes: {
			cors: true,
			files: {
				relativeTo: path.join(__dirname, 'public')
			}
		}
	});

	// Register plugins
	await server.register(Inert);
	await server.register(Susie);

	// Setup development mode authentication bypass
	if (process.env.MODE === 'development') {
		server.ext('onRequest', async (request, h) => {
			console.log('development mode');
			const defaultUser = process.env.DEV_USER || "local.user@localhost";
			// Set the auth header for all requests in development mode
			request.headers[AUTH_HEADER] = defaultUser;
			const user = await Graph.myId(defaultUser);
			request.auth = {
				isAuthenticated: true,
				credentials: { user },
				artifacts: null,
				strategy: 'development'
			};
			return h.continue;
		});
	} else {
		// Custom authentication scheme
		const scheme = (server, options) => {
			return {
				authenticate: async (request, h) => {
					console.log('authenticate');
					console.log(request.headers[AUTH_HEADER]);
					const mail = request.headers[AUTH_HEADER];
					
					if (!mail) {
						throw Boom.unauthorized('Missing mail header');
					}

					try {
						const user = await Graph.myId(mail);
						console.log('user');
						console.log(user);
						if (!user) {
							throw Boom.unauthorized('User not found');
						}

						return h.authenticated({
							credentials: { user },
							artifacts: null
						});
					} catch (error) {
						if (error.isBoom) {
							throw error;
						}
						throw Boom.unauthorized('Authentication failed');
					}
				}
			};
		};

		// Register the custom scheme
		server.auth.scheme('mail-auth', scheme);
		
		// Create the strategy
		server.auth.strategy('mail', 'mail-auth');
		
		// Set as default
		server.auth.default('mail');
	}

	// Setup logging
	winston.transports.DailyRotateFile = DailyRotateFile;
	
	const rotatedLog = new winston.transports.DailyRotateFile({
		filename: 'logs/messydesk-%DATE%.log',
		datePattern: 'YYYY-MM',
		zippedArchive: false,
		maxSize: '20m'
	});

	const logger = winston.createLogger({
		format: winston.format.combine(
			winston.format.timestamp(),
			winston.format.prettyPrint()
		),
		transports: [
			new winston.transports.Console(),
			rotatedLog
		]
	});

	// Error handling
	server.ext('onPreResponse', (request, h) => {
		const response = request.response;
		if (response.isBoom) {
			logger.error({
				user: request.headers[AUTH_HEADER],
				message: response.message,
				params: request.params,
				path: request.path,
				body: request.payload,
				error: response
			});
		}
		return h.continue;
	});

	// Static file serving
	server.route({
		method: 'GET',
		path: '/{param*}',
		handler: {
			directory: {
				path: '.',
				redirectToSlash: true,
				index: true
			}
		},
		options: {
			auth: false
		}
	});

	// Register all routes
	server.route([
		// API root
		{
			method: 'GET',
			path: '/api',
			options: {
				auth: process.env.MODE !== 'development' ? 'mail' : false
			},
			handler: () => 'MessyDesk API'
		},
		// Settings endpoint
		{
			method: 'GET',
			path: '/api/settings',
			options: {
				auth: process.env.MODE !== 'development' ? 'mail' : false
			},
			handler: (request) => ({
				info: 'MessyDesk API',
				version: require('./package.json').version,
				mode: process.env.MODE,
				data_dir: DATA_DIR,
				db: process.env.DB_NAME,
				user: request.auth.credentials.user
			})
		},
		// Import and register all route modules
		...projectRoutes,
		...serviceRoutes,
		...entityRoutes,
		...fileRoutes,
		...graphRoutes,
		...authRoutes,
		...eventRoutes,
		...nomadRoutes,
		...queueRoutes
	]);

	// Start the server
	await server.start();
	console.log('MessyDesk running at:', server.info.uri);

	return server;
};

// Handle process termination
process.on('SIGINT', async () => {
	console.log('\nGracefully shutting down from SIGINT (Ctrl-C)');
	if (process.env.NODE_ENV !== 'production') {
		// Cleanup code if needed
	}
	process.exit();
});

// Initialize and start the server
init().catch((err) => {
	console.error(err);
	process.exit(1);
});


