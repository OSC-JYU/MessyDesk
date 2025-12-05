import userManager from '../userManager.mjs';

export default [
    {
        method: 'GET',
        path: '/events',
        handler: (request, h) => {
            const userRID = request.auth.credentials.user.rid;
            if (!userRID) {
                return h.response({ error: 'User ID is required' }).code(400);
            }

            // Get the last event ID from the request
            const lastEventId = request.headers['last-event-id'];
            console.log('Last event ID:', lastEventId);

            // Store the connection for this user
            userManager.addConnection(userRID, h);

            // Send initial event with a timestamp-based ID
            const initialId = Date.now().toString();
            const response = h.event({ 
                id: initialId,
                data: {message: 'Welcome to MessyDesk!' }
            });

            // Clean up when the connection is closed
            request.raw.req.on('close', () => {
                userManager.removeConnection(userRID);
            });

            return response;
        }
    },
    {
        method: 'GET',
        path: '/events/test',
        handler: (request, h) => {
            const userRID = request.auth.credentials.user.rid;
            console.log(userRID);
            if (!userRID) {
                return h.response({ error: 'User ID is required' }).code(400);
            }
            var users = userManager.getConnectedUsers();
            console.log(users);
            
            // Send test message with a timestamp-based ID
            const messageId = Date.now().toString();
            userManager.sendToUser(userRID, { 
                id: messageId,
                data: { message: 'This is a test message' } 
            });

            return h.response({ message: 'Message sent' });
        }
    },
    {
        method: 'POST',
        path: '/events/test/message',
        handler: (request, h) => {
            console.log('Add node request received');
            const userRID = request.auth.credentials.user.rid;
            const payload = JSON.parse(request.payload);
            console.log(payload);

            if (!userRID) {
                return h.response({ error: 'User ID is required' }).code(400);
            }
            var users = userManager.getConnectedUsers();
            console.log(users);
            
            // Send test message with a timestamp-based ID
            //const messageId = Date.now().toString();
            userManager.sendToUser(userRID, payload);

            return h.response({ message: 'Message sent' });
        }
    }
]; 
