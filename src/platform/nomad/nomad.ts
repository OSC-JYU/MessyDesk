// HashiCorp Nomad client: start and stop service jobs from an HCL spec.

export class NomadClient {
    private readonly url: string;
    private readonly podman: boolean;

    constructor(url: string, podman: boolean) {
        this.url = url.replace(/\/$/, '');
        this.podman = podman;
    }

    /** Nomad service names must be RFC 1123: no underscores. */
    static serviceName(name: string): string {
        return String(name).replace(/_/g, '-');
    }

    private async request(method: string, path: string, body?: unknown): Promise<any> {
        const response = await fetch(this.url + path, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`Nomad ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`);
        return text ? JSON.parse(text) : null;
    }

    async status(): Promise<unknown> {
        return this.request('GET', '/status/leader');
    }

    async start(service: { id: string; nomad_hcl?: string }): Promise<unknown> {
        if (!service?.nomad_hcl) throw new Error(`nomad.hcl not found for "${service?.id}"!`);
        let hcl = service.nomad_hcl;
        if (this.podman) hcl = hcl.replace('driver = "docker"', 'driver = "podman"');
        const job = await this.request('POST', '/jobs/parse', { JobHCL: hcl, Canonicalize: true });
        return this.request('POST', '/jobs', { Job: job });
    }

    async stop(service: { id: string }): Promise<unknown> {
        if (!service?.id) throw new Error('Service id required');
        return this.request('DELETE', `/job/${encodeURIComponent(service.id)}?purge=true`);
    }

    async serviceUrl(name: string): Promise<string> {
        const list = await this.request('GET', `/service/${encodeURIComponent(NomadClient.serviceName(name))}`);
        return Array.isArray(list) && list.length ? `${list[0].Address}:${list[0].Port}` : '';
    }
}
