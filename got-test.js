const fs = require('fs');
const { pipeline } = require('stream');
const FormData = require('form-data');

const imageFilePath = './test/files/test.png'; // Replace with the actual image file path
const imageDestinationUrl = 'http://localhost:9000/crop?width=500&height=400&file=uusi.png'; // Replace with the actual image destination URL
const savedImageFilePath = './saved-image.png'; // Replace with the desired file path to save the returned image

async function sendAndSaveImageFormData() {
  try {
    const got = await import('got');
    
    const readStream = fs.createReadStream(imageFilePath);
    const formData = new FormData();
    formData.append('file', readStream);
    
    console.log('Sending image via POST request...');
    
    const postStream = got.default.stream.post(imageDestinationUrl, {
      body: formData,
      headers: formData.getHeaders(),
    });
    
    const writeStream = fs.createWriteStream(savedImageFilePath);
    
    pipeline(postStream, writeStream, (error) => {
      if (error) {
        console.error('Error sending or saving the image:', error);
      } else {
        console.log('Image sent and saved successfully.');
      }
    });
  } catch (error) {
    console.error('Error reading, sending, or saving the image:', error.message);
  }
}

sendAndSaveImageFormData();

