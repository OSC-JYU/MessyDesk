const fs = require('fs');
const sizeOf = require('image-size');

// Define the local path to the image file
const imgPath = '/home/arihayri/Downloads/bali.tif';


// Read the image from the local drive and log its dimensions
(async () => {
    try {
const dimensions = await sizeOf(imgPath)
   	 console.log(dimensions.width, dimensions.height)
    } catch (error) {
        console.error('Error reading the image:', error);
    }
})();
