// Composition root: builds the configuration, clients and services, then starts the server.

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Deps } from './app/deps.ts';
import { loadConfig } from './config.ts';
import { ArcadeClient } from './platform/arcade/client.ts';
import { ensureDatabase, ensureSchema } from './platform/arcade/schema.ts';
import { registerAuth } from './platform/http/auth.ts';
import { createServer, registerErrorLogging, staticRoute } from './platform/http/server.ts';
import { createLogger } from './platform/logger.ts';
import { NomadClient } from './platform/nomad/nomad.ts';
import { SolrClient } from './platform/solr/solr.ts';
import { SseHub } from './platform/sse/hub.ts';
import { DataLayout } from './platform/storage/layout.ts';
import { GraphStore } from './shared/graph-store.ts';
import { AccessService } from './modules/access/access.ts';
import { BatchState } from './modules/batches/batch-state.ts';
import { FilesService } from './modules/files/files.ts';
import { fileRoutes } from './modules/files/routes.ts';
import { FiltersService } from './modules/filters/filters.ts';
import { GraphService } from './modules/graph/graph.ts';
import { graphRoutes } from './modules/graph/routes.ts';
import { ImportPipeline } from './modules/import/import.ts';
import { miscRoutes } from './modules/misc/routes.ts';
import { NodesService } from './modules/nodes/nodes.ts';
import { ProcessingService } from './modules/processing/processing.ts';
import { processingRoutes } from './modules/processing/routes.ts';
import { DeskGraph } from './modules/projects/desk-graph.ts';
import { ProjectsService } from './modules/projects/projects.ts';
import { projectRoutes } from './modules/projects/routes.ts';
import { PromptsService } from './modules/prompts/prompts.ts';
import { Publisher } from './modules/queue/publisher.ts';
import { JobQueue } from './modules/queue/queue.ts';
import { ResultsService } from './modules/results/results.ts';
import { resultRoutes } from './modules/results/routes.ts';
import { RoisService } from './modules/rois/rois.ts';
import { ServiceGroupsService } from './modules/service-groups/service-groups.ts';
import { ServiceHelp } from './modules/service-help/bundle.ts';
import { loadFilters } from './modules/services/matching.ts';
import { ServiceRegistry } from './modules/services/registry.ts';
import { serviceRoutes } from './modules/services/routes.ts';
import { ZipJobs } from './modules/sets/zip-jobs.ts';
import { NerService } from './modules/tags/ner.ts';
import { tagRoutes } from './modules/tags/routes.ts';
import { TagsService } from './modules/tags/tags.ts';
import { ThumbnailService } from './modules/thumbnails/thumbnails.ts';
import { userRoutes } from './modules/users/routes.ts';
import { UsersService } from './modules/users/users.ts';

async function main(): Promise<void> {
    const config = loadConfig();
    const logger = createLogger(config.dataDir, config.logLevel);
    logger.info(`Data directory: ${config.dataDir}`);
    for (const dir of ['files', 'processes', 'sets', 'projects', 'uploads', 'layouts', 'tmp']) {
        await fsp.mkdir(path.join(config.dataDir, dir), { recursive: true });
    }

    const nomad = new NomadClient(config.nomad.url, config.nomad.podman);
    if (config.nomad.enabled) {
        try {
            await nomad.status();
        } catch (error) {
            logger.error(`Nomad connection failed: ${(error as Error).message}`);
            process.exit(1);
        }
    }

    if (!config.db.password) {
        logger.error('DB_PASSWORD not set! Exiting...');
        process.exit(1);
    }
    const db = new ArcadeClient({ ...config.db, log: (m) => logger.debug(m) });
    logger.info(`ArcadeDB: ${config.db.url} (${config.db.legacy ? 'legacy 23.x mode' : 'current mode'})`);
    let created = false;
    for (let attempt = 1; ; attempt += 1) {
        try {
            created = await ensureDatabase(db, (m) => logger.warn(m));
            break;
        } catch (error) {
            if (attempt >= 2) {
                logger.error(`Could not init database. Is ArcadeDB running at ${config.db.url}? ${(error as Error).message}`);
                process.exit(1);
            }
            logger.warn('Could not reach the database, trying again in 10 seconds...');
            await new Promise((r) => setTimeout(r, 10000));
        }
    }
    await ensureSchema(db, (m) => logger.warn(m));

    const layout = new DataLayout(config.dataDir);
    const store = new GraphStore(db);
    const sse = new SseHub();
    const solr = new SolrClient({ ...config.solr, log: (m) => logger.warn(m) });
    const queue = new JobQueue(config.queue);
    queue.open();
    queue.startSweeper((m) => logger.info(m));
    const publisher = new Publisher(queue, (rid) => store.projectRidOf(rid), logger, config.queue.logContext);
    const access = new AccessService(db);
    const tags = new TagsService(db, access);
    const users = new UsersService(db, store, (rid) => tags.createEntityTypes(rid));
    if (created) logger.info('Database created');
    await users.ensureDefaultAdmin();

    const registry = new ServiceRegistry(config.serviceRegistryPath, config.consumerTtlSeconds);
    await registry.load();
    const nodes = new NodesService(db, store, layout);
    const deskGraph = new DeskGraph(db, config.apiUrl);
    const thumbnails = new ThumbnailService(publisher, layout);
    const importPipeline = new ImportPipeline(store, nodes, registry, publisher, sse);
    const files = new FilesService({ db, store, layout, access, nodes, tags, thumbnails, registry, importPipeline, deskGraph, sse, apiUrl: config.apiUrl, maxVersionTextBytes: config.maxVersionTextBytes });
    const batches = new BatchState(db, store);
    const processing = new ProcessingService({ db, store, layout, access, nodes, files, registry, publisher, batches, sse, solr, apiUrl: config.apiUrl });
    tags.setTagSync((fileRid, userRid, fields) => processing.syncTags(fileRid, userRid, fields));
    const graph = new GraphService(db, store, access, tags, solr, layout);
    const filters = new FiltersService(db, store, layout, access, nodes);
    filters.setFilters(await loadFilters(config.filtersDir, (m) => logger.warn(m)));

    const deps: Deps = {
        config, logger, db, store, layout, sse, solr, nomad, queue, publisher, access, users,
        projects: new ProjectsService(db, store, layout, access, { expirationDays: config.projectExpirationDays, quotaGb: config.diskQuotaGb }),
        deskGraph, nodes, graph, files, thumbnails,
        zipJobs: new ZipJobs(layout, files, publisher, config.setZipJobTtlMs),
        importPipeline, registry,
        serviceHelp: new ServiceHelp({ dir: path.join(config.helpDir, 'services'), bundleMaxFiles: config.help.bundleMaxFiles, archiveMaxBytes: config.help.archiveMaxBytes, archiveMaxEntries: config.help.archiveMaxEntries }),
        processing, batches,
        results: new ResultsService({ db, store, layout, nodes, batches, tags, thumbnails, registry, importPipeline, sse, logger, apiUrl: config.apiUrl }),
        tags,
        ner: new NerService(db),
        filters,
        rois: new RoisService(db, store, access, graph),
        prompts: new PromptsService(db),
        serviceGroups: new ServiceGroupsService(db, store, registry, config.dataDir),
    };

    const server = await createServer(config.port, config.publicDir);
    await registerAuth(server, {
        development: config.development,
        devUser: config.devUser,
        serviceToken: config.serviceToken,
        legacyMail: config.serviceAuthLegacyMail,
        lookup: (mail) => users.find(mail),
        logger,
    });
    registerErrorLogging(server, logger);
    server.route([
        staticRoute(),
        ...miscRoutes(deps),
        ...userRoutes(deps),
        ...projectRoutes(deps),
        ...fileRoutes(deps),
        ...graphRoutes(deps),
        ...processingRoutes(deps),
        ...resultRoutes(deps),
        ...serviceRoutes(deps),
        ...tagRoutes(deps),
    ]);
    await server.start();
    logger.info(`MessyDesk running at: ${server.info.uri}`);

    const shutdown = async () => {
        logger.info('Shutting down');
        sse.closeAll();
        await server.stop({ timeout: 5000 });
        queue.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
