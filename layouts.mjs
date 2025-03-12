import path from 'path';
import fsPromises from 'fs/promises';

// some layouts are same for all users
const COMMON_LAYOUTS = ['projects']

export let layout = {}

layout.setLayout = async function (layout, userId) {

	if (!userId) throw new Error('data missing')

	const filename = `layout_${userId}.json`

	const filePath = path.resolve('./data/layouts', filename)
	const fileData = JSON.stringify(layout)

	await fsPromises.writeFile(filePath, fileData, 'utf8')
}

layout.updateProjectNodePosition = async function (node, userId) {

	var layout = await this.getLayoutByTarget(userId)
    if(node.position) layout[node.id] = node.position

	await this.setLayout(layout, userId)
}

layout.getLayoutByTarget = async function (userId) {

	const filename = `layout_${userId}.json`
	const filePath = path.resolve('./data/layouts', filename)
	try {
		const locations = await fsPromises.readFile(filePath, 'utf8')
		return JSON.parse(locations)
	} catch (e) {
		return {}
	}

}
