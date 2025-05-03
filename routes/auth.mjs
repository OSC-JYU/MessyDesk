import Graph from '../graph.mjs';
import Boom from '@hapi/boom';

export default [
    {
        method: 'GET',
        path: '/api/sso',
        options: {
            auth: false
        },
        handler: (request) => {
            return {
                mail: request.headers.mail,
                name: request.headers.displayname
            };
        }
    },
    {
        method: 'POST',
        path: '/api/permissions/request',
        options: {
            auth: false
        },
        handler: async (request, h) => {
            const userId = request.headers.mail;
            let userName = request.headers.displayname;
            if (!userName) userName = userId;

            if (!userId) {
                throw Boom.badRequest('Missing user identification');
            }

            try {
                const query = `SELECT FROM Request WHERE id = "${userId}"`;
                const res = await Graph.sql(query);
                const query2 = `SELECT FROM User WHERE id = "${userId}"`;
                const res2 = await Graph.sql(query2);

                if (res.result.length > 0 || res2.result.length > 0) {
                    throw Boom.conflict('User has already requested or has access');
                }

                await Graph.createWithSQL('Request', {
                    id: userId,
                    label: userName,
                    date: '[TIMESTAMP]'
                });

                return { status: 'ok' };
            } catch (error) {
                console.log('User request failed: ', userId, error);
                logger.error({
                    user: userId,
                    message: error.message,
                    error: error
                });
                if (error.isBoom) {
                    throw error;
                }
                throw Boom.badImplementation('Failed to process permission request');
            }
        }
    },
    {
        method: 'GET',
        path: '/api/me',
        handler: async (request) => {
            const me = await Graph.myId(request.headers.mail);
            return {
                rid: me.rid,
                admin: me.admin,
                group: me.group,
                access: me.access,
                id: request.headers.mail,
                mode: process.env.MODE || 'production'
            };
        }
    }
]; 