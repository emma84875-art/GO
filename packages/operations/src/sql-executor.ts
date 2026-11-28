// TEMPORARY LOCAL TESTING ADAPTER. NOT PRODUCTION-READY.
//
// psqlExecutor runs each statement through the psql command-line client, with the SQL on standard input. It exists only
// because no PostgreSQL driver can be installed in this environment (the npm registry is unreachable). It is not a
// connection pool, does not reuse connections, opens one process per statement, passes connection settings through the
// environment, and reports errors by parsing psql's exit code. It must not be used in any deployed environment.
//
// The intended replacement is a maintained driver such as `pg`, added as a dependency with its lockfile entry once the
// registry is reachable and the owner approves it (docs/01). The replacement implements the same SqlExecutor type, so
// the ledger, the state layer and the application do not change.

// Runs one SQL statement against PostgreSQL and returns its unaligned, tuples-only output.
//
// The production executor shells out to psql. The SQL is written to psql's standard input, so no statement or value
// appears in the process arguments. Connection settings come from the standard PG* environment variables (PGHOST,
// PGPORT, PGDATABASE, PGUSER, PGPASSWORD or a service file), never from code or from a committed file.
//
// This is a stop-gap for the absence of a database driver dependency, which needs owner approval (docs/01). A driver
// may replace it behind the SqlExecutor type without changing the ledger.

import { spawn } from 'node:child_process';

export type SqlExecutor = (sql: string) => Promise<string>;

export class LedgerDatabaseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LedgerDatabaseError';
    this.code = code;
  }
}

export function psqlExecutor(env: NodeJS.ProcessEnv = process.env, psqlBinary = 'psql'): SqlExecutor {
  return (sql: string) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(psqlBinary, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', (error) => reject(new LedgerDatabaseError('database_unavailable', `Could not start psql: ${error.message}`)));
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
          return;
        }
        // stderr may echo parts of the statement, so it is attached for the caller's own debugging but not in the message.
        const error = new LedgerDatabaseError('database_error', `Ledger database call failed (psql exit ${code}).`);
        (error as Error & { detail?: string }).detail = stderr.trim();
        reject(error);
      });
      child.stdin.end(sql);
    });
}
