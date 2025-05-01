import Hapi from '@hapi/hapi';
import Inert from '@hapi/inert';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import fse from 'fs-extra';
import { pipeline } from 'stream';
import Boom from '@hapi/boom';
import Susie from 'susie';

import Graph from './graph.mjs';
import media from './media.mjs';
import services from './services.mjs';
import nomad from './nomad.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let nats;
let positions;

const DATA_DIR = process.env.DATA_DIR || 'data';
const API_URL = process.env.API_URL || '/';
const AUTH_HEADER = 'mail';
const AUTH_NAME = 'displayname';

const sseClients = new Map();

// Initialize the server
const init = async () => {
	console.log('initing...');
	// migration to ES6 in progress...
	const { queue } = await import('./queue.mjs');
	const { layout } = await import('./layouts.mjs');
	nats = queue;
	positions = layout;
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

	// API Routes
	server.route([
		// SSO endpoint
		{
			method: 'GET',
			path: '/api/sso',
			options: {
				auth: false
			},
			handler: (request) => {
				return {
					mail: request.headers[AUTH_HEADER],
					name: request.headers[AUTH_NAME]
				};
			}
		},
	
		// Allow users to ask for permissions
		{
			method: 'POST',
			path: '/api/permissions/request',
			options: {
				auth: false
			},
			handler: async (request, h) => {
				const userId = request.headers[AUTH_HEADER];
				let userName = request.headers[AUTH_NAME];
				if (!userName) userName = userId;

				if (!userId) {
					throw Boom.badRequest('Missing user identification');
				}

				try {
					const query = `SELECT FROM Request WHERE id = "${userId}"`;
					const res = await Graph.sql(query);
					const query2 = `SELECT FROM User WHERE id = "${userId}"`;
					const res2 = await Graph.sql(query2);

					if (res.result.length > 0 || res2.result.length > 0) {
						throw Boom.conflict('User has already requested or has access');
					}

					await Graph.createWithSQL('Request', {
						id: userId,
						label: userName,
						date: '[TIMESTAMP]'
					});

					return { status: 'ok' };
				} catch (error) {
					console.log('User request failed: ', userId, error);
					logger.error({
						user: userId,
						message: error.message,
						error: error
					});
					if (error.isBoom) {
						throw error;
					}
					throw Boom.badImplementation('Failed to process permission request');
				}
			}
		},

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
		// User endpoints
		{
			method: 'GET',
			path: '/api/me',
			handler: async (request) => {
				const me = await Graph.myId(request.headers[AUTH_HEADER]);
				return {
					rid: me.rid,
					admin: me.admin,
					group: me.group,
					access: me.access,
					id: request.headers[AUTH_HEADER],
					mode: process.env.MODE || 'production'
				};
			}
		},
		// File upload endpoint
		{
			method: 'POST',
			path: '/api/projects/{rid}/upload/{set?}',
			options: {
				payload: {
					maxBytes: 500 * 1024 * 1024,
					output: 'stream',
					parse: true,
					multipart: true,
					allow: 'multipart/form-data'
				}
			},
			handler: async (request, h) => {
				try {
					// Verify project exists and user has access
					const response = await Graph.getProject_old(request.params.rid, request.headers.mail);
					if (response.result.length === 0) {
						throw Boom.notFound('Project not found');
					}

					const project_rid = response.result[0]["@rid"];
					const file = request.payload.file;

					// Validate file exists in payload
					if (!file) {
						throw Boom.badRequest('No file uploaded');
					}

					// Get original filename
					const originalFilename = file.hapi.filename;
					console.log('Uploading file:', originalFilename);

					// Get file type
					const file_type = await media.detectType(file);
					if (!file_type) {
						throw Boom.badRequest('Could not determine file type');
					}

					// For text files, get additional info
					if (file_type === 'text') {
						try {
							file.info = await media.getTextDescription(file.path);
						} catch (error) {
							console.log('Error getting text description:', error);
							// Continue without text description
							file.info = null;
						}
					}

					// Create file node in graph
					const filegraph = await Graph.createOriginalFileNode(
						project_rid, 
						file, 
						file_type, 
						request.params.set, 
						DATA_DIR,
						originalFilename
					);

					// Upload file to storage
					//const file_info = await media.uploadFile(file.path, filegraph, DATA_DIR);
					var filepath = filegraph.path.split('/').slice( 0, -1 ).join('/')
					await fse.ensureDir(path.join(filepath, 'process'))

					const filesave = fs.createWriteStream(filegraph.path);

					filesave.on('error', (err) => console.error(err));

					file.pipe(filesave);

					filesave.on('end', (err) => { 

						// Update metadata if available
						if (file_info) {
							Graph.setNodeAttribute(filegraph['@rid'], { 
								key: 'metadata', 
								value: file_info 
							});
						}

						// Handle different file types
						if (file_type === 'text') {
							const index_msg = {
								id: 'solr',
								task: 'index',
								file: filegraph,
								userId: request.auth.credentials.user.id,
								target: filegraph['@rid']
							};
							nats.publish(index_msg.id, JSON.stringify(index_msg));
						} else if (file_type === 'image') {
							const data = {
								file: filegraph,
								userId: request.headers[AUTH_HEADER],
								target: filegraph['@rid'],
								task: 'thumbnail',
								params: { width: 800, type: 'jpeg' },
								id: 'md-thumbnailer'
							};
							nats.publish('md-thumbnailer', JSON.stringify(data));
						} else if (file_type === 'pdf') {
							const data = {
								file: filegraph,
								userId: request.headers[AUTH_HEADER],
								target: filegraph['@rid'],
								task: 'pdf2images',
								params: {
									firstPageToConvert: '1',
									lastPageToConvert: '1',
									resolutionXYAxis: '80',
									task: 'pdf2images'
								},
								role: 'thumbnail',
								id: 'md-poppler'
							};
							nats.publish('md-poppler', JSON.stringify(data));
						}

						// Notify UI if user is authenticated
						if (request.headers[AUTH_HEADER]) {
							const wsdata = {
								command: 'add',
								type: file_type,
								node: filegraph,
								set: request.params.set
							};
							send2UI(request.headers[AUTH_HEADER], wsdata);
						}
					})

					return filegraph;

				} catch (error) {
					console.error('File upload error:', error);
					if (error.isBoom) {
						throw error;
					}
					throw Boom.badImplementation('Failed to process file upload');
				}
			}
		},
		{
			method: 'GET', 
			path: '/api/thumbnails/{param*}',
			handler: async (request, h) => {
				return 'test'
				const src = await media.getThumbnail(request.params.param);
				const response = h.response(src);
				response.type('image/jpeg');
				return response;
			}
		},
		// File download endpoint
		{
			method: 'GET',
			path: '/api/files/{file_rid}',
			handler: async (request, h) => {
				try {
					const file_metadata = await Graph.getUserFileMetadata(
						Graph.sanitizeRID(request.params.file_rid),
						request.headers.mail
					);

					const src = fs.createReadStream(file_metadata.path);
					const response = h.response(src);

					if (file_metadata.type === 'pdf') {
						response.header('Content-Disposition', `inline; filename=${file_metadata.label}`);
						response.type('application/pdf');
					} else if (file_metadata.type === 'image') {
						response.type('image/png');
					} else if (file_metadata.type === 'text' || file_metadata.type === 'data') {
						response.type('text/plain; charset=utf-8');
					} else {
						response.header('Content-Disposition', `attachment; filename=${file_metadata.label}`);
					}

					return response;
				} catch (e) {
					return h.response().code(403);
				}
			}
		},
		// Project endpoints
		{
			method: 'POST',
			path: '/api/projects',
			handler: async (request) => {
				const me = await Graph.myId(request.headers.mail);
				if (!request.payload.label) {
					throw new Error('label required');
				}
				const project = await Graph.createProject(request.payload, me.rid);
				await media.createProjectDir(project, DATA_DIR);
				return project;
			}
		},
		{
			method: 'GET',
			path: '/api/projects',
			handler: async (request) => {
				return await Graph.getProjects(request.headers.mail, DATA_DIR);
			}
		},
		{
			method: 'GET',
			path: '/api/projects/{rid}',
			handler: async (request) => {
				return await Graph.getProject_backup(
					Graph.sanitizeRID(request.params.rid),
					request.headers.mail
				);
			}
		},
		{
			method: 'DELETE',
			path: '/api/projects/{rid}',
			handler: async (request) => {
				return await Graph.deleteProject(
					Graph.sanitizeRID(request.params.rid),
					request.headers.mail,
					nats
				);
			}
		},
		{
			method: 'GET',
			path: '/api/projects/{rid}/files',
			handler: async (request) => {
				const result = await Graph.getProjectFiles(
					Graph.sanitizeRID(request.params.rid),
					request.headers.mail
				);
				return result.result;
			}
		},
		// Services endpoints
		{
			method: 'GET',
			path: '/api/services',
			handler: async () => {
				return await services.getServices();
			}
		},
		{
			method: 'POST',
			path: '/api/services/reload',
			handler: async (request, h) => {
				try {
					await services.loadServiceAdapters();
					return { status: 'ok', service: services };
				} catch (e) {
					console.log(e);
					return h.response({ error: e }).code(500);
				}
			}
		},
		{
			method: 'GET',
			path: '/api/services/files/{rid}',
			handler: async (request) => {
				const file = await Graph.getUserFileMetadata(
					Graph.sanitizeRID(request.params.rid),
					request.headers.mail
				);
				const prompts = await Graph.getPrompts(request.auth.credentials.user.id);

				if (file) {
					return await services.getServicesForNode(
						file,
						request.query.filter,
						request.auth.credentials.user,
						prompts
					);
				}
				return [];
			}
		},
		// Graph endpoints
		{
			method: 'GET',
			path: '/api/graph/traverse/{rid}/{direction}',
			handler: async (request, h) => {
				try {
					const traverse = await Graph.traverse(
						Graph.sanitizeRID(request.params.rid),
						request.params.direction,
						request.auth.credentials.user.rid
					);
					if (!traverse) {
						return h.response().code(404);
					}
					return traverse;
				} catch (e) {
					throw e;
				}
			}
		},
		{
			method: 'POST',
			path: '/api/graph/query',
			handler: async (request) => {
				return await Graph.getGraph(request.payload, request);
			}
		},
		{
			method: 'POST',
			path: '/api/graph/vertices',
			handler: async (request) => {
				const type = request.payload.type;
				const result = await Graph.create(type, request.payload);
				console.log(result);
				return result;
			}
		},
		{
			method: 'GET',
			path: '/api/graph/vertices/{rid}',
			handler: async (request) => {
				return await Graph.getNode(
					Graph.sanitizeRID(request.params.rid),
					request.auth.credentials.user.rid
				);
			}
		},
		{
			method: 'POST',
			path: '/api/graph/vertices/{rid}',
			handler: async (request) => {
				const clean_rid = Graph.sanitizeRID(request.params.rid);
				const result = await Graph.setNodeAttribute(clean_rid, request.payload);
				
				if (request.payload.key && request.payload.key === 'description') {
					const wsdata = {
						command: 'update',
						target: clean_rid,
						description: request.payload.value
					};
					await send2UI(request.auth.credentials.user.id, wsdata);
				}
				
				return result;
			}
		},
		{
			method: 'DELETE',
			path: '/api/graph/vertices/{rid}',
			handler: async (request) => {
				const result = await Graph.deleteNode(
					Graph.sanitizeRID(request.params.rid),
					nats
				);
				console.log(result);
				if (result.path) {
					// TODO: delete path
					console.log(result.path);
				}
				return result;
			}
		},
		{
			method: 'POST',
			path: '/api/graph/edges',
			handler: async (request) => {
				return await Graph.connect(
					request.payload.from,
					request.payload.relation,
					request.payload.to
				);
			}
		},
		{
			method: 'DELETE',
			path: '/api/graph/edges/{rid}',
			handler: async (request) => {
				return await Graph.deleteEdge(Graph.sanitizeRID(request.params.rid));
			}
		},
		{
			method: 'POST',
			path: '/api/graph/edges/{rid}',
			handler: async (request) => {
				return await Graph.setEdgeAttribute(
					Graph.sanitizeRID(request.params.rid),
					request.payload
				);
			}
		},
		{
			method: 'GET',
			path: '/events',
			handler: (request, h) => {
				const userId = request.headers[AUTH_HEADER];
				console.log(userId)

				const respons = h.event({ id: 1, data: 'my data' });
 
				setTimeout(function () {
		 
					h.event({ id: 2, data: { a: 1 } }); // object datum
				}, 500);
		 
				const interval = setInterval(() => {
					const data = JSON.stringify({ time: new Date().toISOString() });
					h.event({data: data});
				  }, 2000);

				return respons;
				
				// Set SSE headers
				const response = h.response();
				const stream = response.raw.res;
				response.type('text/event-stream');
				response.header('Cache-Control', 'no-cache');
				response.header('Connection', 'keep-alive');

				// Create a new SSE client
				const client = {
					id: userId,
					send: (data) => {
						stream.write(`data: ${JSON.stringify(data)}\n\n`);
					}
				};

				// Store the client
				sseClients.set(userId, client);

				// Handle client disconnect
				request.raw.req.on('close', () => {
					sseClients.delete(userId);
				});

				// Send initial connection message
				client.send({ type: 'connected', userId });

				// Keep the connection open
				stream.write('\n');

				return response;
			}
		}
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

// Replace the send2UI function
async function send2UI(userId, data) {
	const client = sseClients.get(userId);
	if (client) {
		client.send(data);
	} else {
		console.log('SSE client not found!', userId);
	}
}

export { send2UI };
