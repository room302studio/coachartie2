declare module 'winston-loki' {
  import { transport } from 'winston';

  interface LokiTransportOptions {
    host: string;
    basicAuth?: string;
    labels?: Record<string, string>;
    json?: boolean;
    batching?: boolean;
    batchInterval?: number;
    batchSize?: number;
    timeout?: number;
    replaceTimestamp?: boolean;
    gracefulShutdown?: boolean;
    format?: any;
  }

  class LokiTransport extends transport {
    constructor(options: LokiTransportOptions);
  }

  export = LokiTransport;
}
