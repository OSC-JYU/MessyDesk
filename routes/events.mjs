import userManager from '../userManager.mjs';

export default [
    {
        method: 'GET',
        path: '/events',
        handler: (request, h) => {
            const userId = request.headers.mail;
            if (!userId) {
                return h.response({ error: 'User ID is required' }).code(400);
            }

            // Get the last event ID from the request
            const lastEventId = request.headers['last-event-id'];
            console.log('Last event ID:', lastEventId);

            // Store the connection for this user
            userManager.addConnection(userId, h);

            // Send initial event with a timestamp-based ID
            const initialId = Date.now().toString();
            const response = h.event({ 
                id: initialId,
                data: {message: 'Welcome to MessyDesk!' }
            });

            // Clean up when the connection is closed
            request.raw.req.on('close', () => {
                userManager.removeConnection(userId);
            });

            return response;
        }
    },
    {
        method: 'GET',
        path: '/events/test',
        handler: (request, h) => {
            const userId = request.headers.mail;
            console.log(userId);
            if (!userId) {
                return h.response({ error: 'User ID is required' }).code(400);
            }
            var users = userManager.getConnectedUsers();
            console.log(users);
            
            // Send test message with a timestamp-based ID
            const messageId = Date.now().toString();
            userManager.sendToUser(userId, { 
                id: messageId,
                data: { message: 'This is a test message' } 
            });

            return h.response({ message: 'Message sent' });
        }
    }
]; 
