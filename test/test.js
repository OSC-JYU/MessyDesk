

let chai = require('chai');
let chaiHttp = require('chai-http');
let should = chai.should();


let url = "http://localhost:8200/api";

var project_id = null;

var file1_id = null
var file2_id = null
var file3_id = null


chai.use(chaiHttp);


describe('Projects', () => {


	describe('/POST projects', () => {
		it('should create a project', (done) => {
			let project = {
				label: `Test project ${Math.random()*100}`,
				description: 'Here is the description of this project.'
			};
			chai.request(url)
				.post('/projects')
				.send(project)
				.end((err, res) => {
					//console.log(res.body)
					res.should.have.status(200);
					res.body.should.be.a('object');

					project_id = res.body.result[0]['@rid'];
					done();
				});
		});
	});

})



describe('Files', () => {

	describe('/POST files', () => {
		it('should upload file to project', (done) => {

			chai.request(url)
				.post(`/projects/${project_id.replace('#','')}/upload`)
				.attach('file', './test/files/test.pdf', 'test.pdf')
				.end((err, res) => {
					//console.log(res.body)
					res.should.have.status(200);
					res.body.should.be.a('object');

					file1_id = res.body['@rid'];
					done();
				});
		});



		it('should upload file to project', (done) => {

			chai.request(url)
				.post(`/projects/${project_id.replace('#','')}/upload`)
				.attach('file', './test/files/face.jpeg', 'face.jpeg')
				.end((err, res) => {
					//console.log(res.body)
					res.should.have.status(200);
					res.body.should.be.a('object');

					file2_id = res.body['@rid'];
					done();
				});
		});


		it('should upload file to project', (done) => {

			chai.request(url)
				.post(`/projects/${project_id.replace('#','')}/upload`)
				.attach('file', './test/files/jyudig.pdf', 'jyudig.pdf')
				.end((err, res) => {
					//console.log(res.body)
					res.should.have.status(200);
					res.body.should.be.a('object');

					file3_id = res.body['@rid'];
					done();
				});
		});
	});



})


describe('Process', () => {


	describe('/POST queue', () => {
		it('should rotate image 180 degrees', (done) => {
			let prosess = {
				id: 'md-imaginary',
				info: 'I rotated image 180 degrees',
				task: 'rotate',
				params: {
					rotate: '180'
				}
			};
			chai.request(url)
				.post(`/queue/md-imaginary/files/${file2_id.replace('#','')}`)
				.send(prosess)
				.end((err, res) => {
					//console.log(res.body)
					res.should.have.status(200);
					res.body.should.be.a('object');

					//project_id = res.body.result[0]['@rid'];
					done();
				});
		});

		it('should rotate image 180 degrees', (done) => {
			let prosess = {
				id: 'md-imaginary',
				info: 'I rotated image 180 degrees',
				task: 'rotate',
				params: {
					rotate: '90'
				}
			};
			chai.request(url)
				.post(`/queue/md-imaginary/files/${file2_id.replace('#','')}`)
				.send(prosess)
				.end((err, res) => {
					//console.log(res.body)
					res.should.have.status(200);
					res.body.should.be.a('object');

					//project_id = res.body.result[0]['@rid'];
					done();
				});
		});

	});

})
