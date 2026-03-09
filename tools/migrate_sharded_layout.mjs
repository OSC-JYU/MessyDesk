#!/usr/bin/env node

import path from 'path'
import fs from 'fs-extra'
import { randomBytes } from 'crypto'

import db from '../src/db.mjs'
import media from '../src/media.mjs'
import { DATA_DIR } from '../src/env.mjs'

const dryRun = process.argv.includes('--dry-run')

const stats = {
	files: { scanned: 0, moved: 0, updated: 0, skipped: 0, errors: 0 },
	processes: { scanned: 0, moved: 0, updated: 0, skipped: 0, errors: 0 },
	sets: { scanned: 0, moved: 0, updated: 0, skipped: 0, errors: 0 },
	sources: { scanned: 0, moved: 0, updated: 0, skipped: 0, errors: 0 }
}

function uuidv7() {
	const bytes = randomBytes(16)
	const ts = Date.now()

	bytes[0] = (ts / 0x10000000000) & 0xff
	bytes[1] = (ts / 0x100000000) & 0xff
	bytes[2] = (ts / 0x1000000) & 0xff
	bytes[3] = (ts / 0x10000) & 0xff
	bytes[4] = (ts / 0x100) & 0xff
	bytes[5] = ts & 0xff

	bytes[6] = (bytes[6] & 0x0f) | 0x70
	bytes[8] = (bytes[8] & 0x3f) | 0x80

	const hex = bytes.toString('hex')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function esc(str) {
	return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function setNodePath(type, rid, targetPath) {
	const query = `UPDATE ${type} SET path = "${esc(targetPath)}" WHERE @rid = ${rid}`
	if (!dryRun) {
		await db.sql(query)
	}
}

async function setNodeUUID(type, rid, uuid) {
	const query = `UPDATE ${type} SET uuid = "${esc(uuid)}" WHERE @rid = ${rid}`
	if (!dryRun) {
		await db.sql(query)
	}
}

async function ensureNodeUUID(type, node) {
	if (node.uuid && media.isUUID(node.uuid)) {
		return node.uuid
	}
	const uuid = uuidv7()
	await setNodeUUID(type, node['@rid'], uuid)
	return uuid
}

async function moveFileIfNeeded(oldPath, newPath, bucketStats) {
	if (!oldPath || oldPath === newPath) {
		bucketStats.skipped += 1
		return
	}

	const oldExists = await fs.pathExists(oldPath)
	if (!oldExists) {
		bucketStats.skipped += 1
		return
	}

	await fs.ensureDir(path.dirname(newPath))
	const newExists = await fs.pathExists(newPath)
	if (!newExists) {
		if (!dryRun) {
			await fs.move(oldPath, newPath)
		}
		bucketStats.moved += 1
	}
}

async function moveDirIfNeeded(oldPath, newPath, bucketStats) {
	if (!oldPath || oldPath === newPath) {
		bucketStats.skipped += 1
		return
	}

	const oldExists = await fs.pathExists(oldPath)
	if (!oldExists) {
		bucketStats.skipped += 1
		return
	}

	const newExists = await fs.pathExists(newPath)
	if (!newExists) {
		await fs.ensureDir(path.dirname(newPath))
		if (!dryRun) {
			await fs.move(oldPath, newPath)
		}
		bucketStats.moved += 1
	} else {
		if (!dryRun) {
			await fs.copy(oldPath, newPath, { overwrite: false, errorOnExist: false })
			await fs.remove(oldPath)
		}
		bucketStats.moved += 1
	}
}

function normalizePath(p) {
	if (!p) return p
	return path.normalize(p)
}

async function buildSetManifest(setRid, setPath, setLabel, setCount) {
	const itemQuery = `MATCH {type:Set, as:set, where:(@rid = ${setRid})}-HAS_ITEM->{as:item}
		RETURN item.@rid AS rid, item.@type AS node, item.label AS label, item.path AS path, item.type AS type`
	const itemsResponse = await db.sql(itemQuery)

	return {
		set: {
			rid: setRid,
			label: setLabel || '',
			count: setCount || 0,
			path: setPath
		},
		updated_at: new Date().toISOString(),
		items: itemsResponse.result || []
	}
}

async function getProjectRidForNode(nodeRid) {
	const query = `MATCH {type:Project, as:project}-->{as:node, where:(@rid = ${nodeRid}), while:($depth < 40)} RETURN project.@rid AS rid LIMIT 1`
	const response = await db.sql(query)
	if(response.result[0] && response.result[0].rid) {
		return response.result[0].rid
	}
	return null
}

async function migrateFiles() {
	const response = await db.sql('SELECT @rid, uuid, path, extension FROM File WHERE path IS NOT NULL')

	for (const node of response.result) {
		stats.files.scanned += 1
		try {
			const uuid = await ensureNodeUUID('File', node)
			const projectRid = await getProjectRidForNode(node['@rid'])
			const newPath = media.getFilePath(DATA_DIR, projectRid, uuid, node.extension)
			const oldPath = normalizePath(node.path)
			const targetPath = normalizePath(newPath)

			await moveFileIfNeeded(oldPath, targetPath, stats.files)
			if (oldPath !== targetPath) {
				await setNodePath('File', node['@rid'], targetPath)
				stats.files.updated += 1
			}
		} catch (e) {
			stats.files.errors += 1
			console.error('File migration failed:', node['@rid'], e.message)
		}
	}
}

async function migrateProcesses() {
	const response = await db.sql('SELECT @rid, uuid, path FROM Process WHERE path IS NOT NULL')

	for (const node of response.result) {
		stats.processes.scanned += 1
		try {
			const uuid = await ensureNodeUUID('Process', node)
			const projectRid = await getProjectRidForNode(node['@rid'])
			const targetFilesPath = normalizePath(media.getProcessFilesDir(DATA_DIR, projectRid, uuid))
			const oldPath = normalizePath(node.path)

			let oldRoot = oldPath
			if (path.basename(oldPath) === 'files') {
				oldRoot = path.dirname(oldPath)
			}
			const targetRoot = path.dirname(targetFilesPath)

			await moveDirIfNeeded(oldRoot, targetRoot, stats.processes)
			if (oldPath !== targetFilesPath) {
				await setNodePath('Process', node['@rid'], targetFilesPath)
				stats.processes.updated += 1
			}
		} catch (e) {
			stats.processes.errors += 1
			console.error('Process migration failed:', node['@rid'], e.message)
		}
	}
}

async function migrateSets() {
	const response = await db.sql('SELECT @rid, uuid, path, label, count FROM Set')

	for (const node of response.result) {
		stats.sets.scanned += 1
		try {
			const uuid = await ensureNodeUUID('Set', node)
			const projectRid = await getProjectRidForNode(node['@rid'])
			const targetPath = normalizePath(media.getSetDir(DATA_DIR, projectRid, uuid))
			const oldPath = normalizePath(node.path)

			if (oldPath) {
				await moveDirIfNeeded(oldPath, targetPath, stats.sets)
			} else {
				await fs.ensureDir(targetPath)
			}

			if (oldPath !== targetPath) {
				await setNodePath('Set', node['@rid'], targetPath)
				stats.sets.updated += 1
			}

			const manifest = await buildSetManifest(node['@rid'], targetPath, node.label, node.count)
			if (!dryRun) {
				await media.writeJSON(manifest, 'set.json', targetPath)
			}
		} catch (e) {
			stats.sets.errors += 1
			console.error('Set migration failed:', node['@rid'], e.message)
		}
	}
}

async function migrateSources() {
	const response = await db.sql('SELECT @rid, uuid, path FROM Source WHERE path IS NOT NULL')

	for (const node of response.result) {
		stats.sources.scanned += 1
		try {
			const uuid = await ensureNodeUUID('Source', node)
			const projectRid = await getProjectRidForNode(node['@rid'])
			const targetPath = normalizePath(media.getSourceDir(DATA_DIR, projectRid, uuid))
			const oldPath = normalizePath(node.path)

			await moveDirIfNeeded(oldPath, targetPath, stats.sources)
			if (oldPath !== targetPath) {
				await setNodePath('Source', node['@rid'], targetPath)
				stats.sources.updated += 1
			}
		} catch (e) {
			stats.sources.errors += 1
			console.error('Source migration failed:', node['@rid'], e.message)
		}
	}
}

async function main() {
	console.log('--- MessyDesk sharded layout migration ---')
	console.log('DATA_DIR:', DATA_DIR)
	console.log('Mode:', dryRun ? 'dry-run' : 'write')

	await media.createDataDir(DATA_DIR)

	await migrateFiles()
	await migrateProcesses()
	await migrateSets()
	await migrateSources()

	console.log('\nMigration summary:')
	console.log(JSON.stringify(stats, null, 2))
}

main().catch((e) => {
	console.error('Migration failed:', e)
	process.exit(1)
})
