


//const { promisify } = require("util")

const sizeOf = require("image-size")
var exifr = require('exifr')

async function main() {
	try {
		const dimensions = await sizeOf("/home/arihayri/Downloads/IMG_1271.jpg")
		console.log(dimensions)
		// only orientation
		let num = await exifr.rotation("/home/arihayri/Downloads/IMG_1271.jpg")
		console.log(num.deg)
	} catch (error) {
		console.log(error)
	}

}

main()