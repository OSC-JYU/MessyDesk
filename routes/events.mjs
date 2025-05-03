import { send2UI } from '../index.mjs';

export default [
    {
        method: 'GET',
        path: '/events',
        handler: (request, h) => {
            const userId = request.headers.mail;
            console.log(userId);

            const respons = h.event({ id: 1, data: 'my data' });

            setTimeout(function () {
                h.event({ id: 2, data: { a: 1 } }); // object datum
            }, 500);

            return respons;
        }
    }
]; 