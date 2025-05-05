// User connection manager
const userConnections = new Map();

export const userManager = {
    // Add a new user connection
    addConnection(userId, connection) {
        if (!userId) {
            throw new Error('User ID is required');
        }
        userConnections.set(userId, connection);
        console.log(`User ${userId} connected`);
    },

    // Remove a user connection
    removeConnection(userId) {
        if (userConnections.has(userId)) {
            userConnections.delete(userId);
            console.log(`User ${userId} disconnected`);
        }
    },

    // Send message to a specific user
    sendToUser(userId, message) {
        const connection = userConnections.get(userId);
        
        if (connection) {
            const initialId = Date.now().toString();
            const response = connection.event({ 
                id: initialId,
                data: message
            });
            return response;
        }
        return false;
    },

    // Check if a user is connected
    isUserConnected(userId) {
        return userConnections.has(userId);
    },

    // Get all connected users
    getConnectedUsers() {
        return Array.from(userConnections.keys());
    }
};

export default userManager; 