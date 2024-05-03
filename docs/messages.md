# NATS messages

Messages send to NATS stream includes:

- id = stream name
- task = service task name
- userId = user who is sending request
- target = which file should be processed
- file = filenode content 
- params = parameters for task

## example message


    {
        file: {
            '@rid': '#31:8',
            '@type': 'File',
            type: 'image',
            extension: 'jpg',
            label: 'IMG_3469.JPG',
            _active: true,
            path: 'data/projects/73_1/files/31_8/31_8.jpg'
        },
        userId: 'local.user@localhost',
        target: '#31:8',
        task: 'thumbnail',
        params: { width: 800, type: 'jpeg', size: 200 },
        id: 'thumbnailer',
        thumb_name: 'thumbnail.jpg'
    }
