// User connection manager
const userConnections = new Map();

export const userManager = {
    // Add a new user connection
    addConnection(userRID, connection) {
        if (!userRID) {
            throw new Error('User ID is required');
        }
        userConnections.set(userRID, connection);
        console.log(`User ${userRID} connected`);
    },

    // Remove a user connection
    removeConnection(userRID) {
        if (userConnections.has(userRID)) {
            userConnections.delete(userRID);
            console.log(`User ${userRID} disconnected`);
        }
    },

    // Send message to a specific user
    sendToUser(userRID, message) {
        console.log('SENDING TO USER: ', userRID)
        const connection = userConnections.get(userRID);
        
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
    isUserConnected(userRID) {
        return userConnections.has(userRID);
    },

    // Get all connected users
    getConnectedUsers() {
        return Array.from(userConnections.keys());
    }
};

export default userManager; 