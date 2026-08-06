declare module 'pg' {
  export class Client {
    constructor(config?: { connectionString?: string });
    connect(): Promise<void>;
    query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
    end(): Promise<void>;
  }
}
