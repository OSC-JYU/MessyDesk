// Request typing for every route: path params are strings, query values strings (or arrays).

declare module '@hapi/hapi' {
    interface ReqRefDefaults {
        Params: Record<string, string>;
        Query: Record<string, any>;
        Payload: any;
    }
}

export {};
