import nodemailer from 'nodemailer'


const from = process.env.FROM
const mailto = process.env.MAILTO
const mailerhost = process.env.MAILER || 'localhost'
const port = process.env.MAILER_PORT || 1025

const transporter = nodemailer.createTransport({
	host: mailerhost,
	port: port,
	secure: false,
	tls: { minVersion: 'TLSv1' }
  });


  let mailer = {}
  mailer.sendMail = async function(mail) {
	try {
		var message = {
			from: from,
			to: mailto,
			subject: `MessyDesk user request: ${mail}`, // Subject line
			text: `MessyDesk user request\nUser: ${mail}\n`, // plain text body
			html: `<h3>MessyDesk user request</h3><ul><li>${mail}</li></ul>` // html body
		}
	
		const info = await transporter.sendMail(message)
		console.log("Message sent: %s", info.messageId);
		return info.messageId	
	} catch(e) {
		console.log('Sending mail failed', e)
	}

}