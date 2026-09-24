import path from 'path';
import fs from 'fs';

export const filters = {filter_list: {}}

// The 4 tool categories from docs/help/3.tools.md; filters without a valid value show as "Uncategorized" in the UI.
// 'system' is a 5th category for internal-only filters that are never listed in the crunchers UI.
const ALLOWED_CATEGORIES = ['preparation', 'linguistic', 'ml', 'generative', 'system']

filters.loadFilters   = async function(filter_path = 'filters') {

    const directoryPath = filter_path
	try {

		// Read the subdirectories in the specified directory
		const subdirectories = await fs.promises.readdir(directoryPath, { withFileTypes: true })
			.then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name));

		// Loop through each subdirectory
		for (const subdirectory of subdirectories) {
			// Get the path to the JSON file in the subdirectory
			const filePath = path.join(directoryPath, subdirectory)

			try {
				// Read the content of the JSON file
				const fileContent = await fs.promises.readFile(path.join(filePath, 'filter.json'), 'utf-8');

				// Parse the JSON content
				const jsonData = JSON.parse(fileContent)
				if(jsonData.category !== undefined && !ALLOWED_CATEGORIES.includes(jsonData.category)) {
					console.error(`WARN: filter '${subdirectory}' has invalid category '${jsonData.category}', treating as uncategorized`);
					delete jsonData.category;
				}
				// Add the data to the result object with the subdirectory name as the key
				filters.filter_list[subdirectory] = jsonData;
			} catch (error) {
				console.error(`Error reading or parsing JSON file in ${subdirectory}: ${error.message}`);
			}
		}
    } catch(error) {
        console.error(`Error reading or parsing JSON file in ${directoryPath}: ${error.message}`);
    }
    return filters.filter_list;
}

filters.getFilter = function(id) {
	return filters.filter_list[id];
}

filters.getFilters = function() {
	return filters.filter_list;
}

export default filters;