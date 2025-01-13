const fs = require('fs');
const sizeOf = require('image-size');

// Define the local path to the image file
const imgPath = '/home/arihayri/Downloads/451408_451411_1969.jpg';

// Function to get the image size from a stream
async function getStreamImageSize(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
        try {
            return sizeOf(Buffer.concat(chunks));
        } catch (error) {
            // Ignore and keep collecting chunks until the image is fully available
        }
    }

    // Once all chunks are received, calculate the image size
    return sizeOf(Buffer.concat(chunks));
}

// Create a read stream for the local image
const stream = fs.createReadStream(imgPath);

// Process the stream and log the image dimensions
(async () => {
    try {
        const dimensions = await getStreamImageSize(stream);
        console.log(dimensions);
    } catch (error) {
        console.error('Error reading the image:', error);
    }
})();

