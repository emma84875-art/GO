// Structured logging for the search service.
//
// The field set is closed. Each log line carries only the fields below, so request bodies, search
// details, traveller names, offers, tokens and provider responses cannot be logged by accident: the
// type does not allow them. Log lines are one JSON object per line.

export type LogFields = {
  readonly event: 'started' | 'request' | 'config_error';
  readonly route?: string;
  readonly status?: number;
  readonly outcome?: string;
  readonly reason?: string;
  readonly durationMs?: number;
  readonly supplier?: string;
  readonly credentialsConfigured?: boolean;
  readonly port?: number;
};

export type LogSink = (line: string) => void;

export function stdoutSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function logEvent(fields: LogFields, sink: LogSink = stdoutSink, now: () => number = Date.now): void {
  sink(JSON.stringify({ time: new Date(now()).toISOString(), service: 'go-search', ...fields }));
}
