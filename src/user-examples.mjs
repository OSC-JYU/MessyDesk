import Graph from './graph.mjs';
import media from './media.mjs';
import nats from './queue.mjs';


// Early test for creating a project and a file directly 

const userRID = '#49:0';

var project_data = {
    label: 'Test JS Project',
    description: 'This is a test project'
}

// const project = await Graph.createProject(project_data, userRID);
// await media.createProjectDir(project, 'data');

var file_data = {
    label: 'Test JS File',
    description: 'This is a test file'
}
var project_rid = '#4:8'
var project = await Graph.getProject(project_rid, userRID);

const filegraph = await Graph.createOriginalFileNode(
    project_rid,
    file_data,
    'image',
    null,
    'data',
    'kissa.jpg'
);