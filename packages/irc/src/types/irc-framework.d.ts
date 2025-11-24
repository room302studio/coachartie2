declare module 'irc-framework' {
  export class Client {
    connected: boolean;
    user: {
      nick: string;
    };
    network: {
      channels: Map<
        string,
        {
          name: string;
        }
      >;
    };

    connect(options: {
      host: string;
      port: number;
      nick: string;
      username: string;
      gecos: string;
      tls?: boolean;
      auto_reconnect?: boolean;
      auto_reconnect_wait?: number;
      auto_reconnect_max_retries?: number;
    }): void;

    on(event: 'registered', handler: () => void): void;
    on(event: 'close', handler: () => void): void;
    on(event: 'socket close', handler: () => void): void;
    on(event: 'socket error', handler: (error: Error) => void): void;
    on(event: 'error', handler: (error: Error) => void): void;
    on(
      event: 'privmsg',
      handler: (event: {
        nick: string;
        target: string;
        message: string;
        time?: number;
        hostname?: string;
        ident?: string;
      }) => void
    ): void;
    on(
      event: 'join',
      handler: (event: { nick: string; channel: string; time?: number }) => void
    ): void;
    on(
      event: 'part',
      handler: (event: { nick: string; channel: string; time?: number }) => void
    ): void;

    say(target: string, message: string): void;
    join(channel: string): void;
    quit(message?: string): void;
  }
}
