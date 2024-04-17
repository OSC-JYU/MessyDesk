import path from 'path';
import fsPromises from 'fs/promises';

// some layouts are same for all users
const COMMON_LAYOUTS = ['projects']

export let layout = {}

layout.setLayout = async function (layout) {
	const { target, data } = layout
	if (!target || !data) throw new Error('data missing')

	const filename = COMMON_LAYOUTS.includes(target)
		? `layout_${target}-${target}.json`
		: `layout_${target.replace(/^#/, '')}.json`

	const filePath = path.resolve('./layouts', filename)
	const fileData = JSON.stringify(data)

	await fsPromises.writeFile(filePath, fileData, 'utf8')
}

layout.updateProjectNodePosition = async function (node) {
	var layout = await this.getLayoutByTarget('projects')
    if(node.position) layout[node.id] = node.position

	await this.setLayout({target:'projects',data: layout})
}

layout.getLayoutByTarget = async function (target) {

	const filename = COMMON_LAYOUTS.includes(target)
		? `layout_${target}-${target}.json`
		: `layout_${target.replace(/^#/, '')}.json`

	const filePath = path.resolve('./layouts', filename)
	try {
		const locations = await fsPromises.readFile(filePath, 'utf8')
		return JSON.parse(locations)
	} catch (e) {
		return {}
	}

}
