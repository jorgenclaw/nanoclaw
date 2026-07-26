import { execFile } from 'child_process';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

export type AuthMode = 'api-key' | 'oauth';

/**
 * Claude-provider containers reach this proxy via `host.docker.internal`,
 * which Docker's `--add-host=host.docker.internal:host-gateway` resolves to
 * the default bridge's gateway IP (e.g. 172.17.0.1) — NOT 127.0.0.1. A proxy
 * bound to loopback only accepts connections arriving on the loopback
 * interface, so containers get ECONNREFUSED even once they reach the host
 * correctly (confirmed 2026-07-26 debugging a stuck Claude-provider agent).
 *
 * Bind to that gateway IP instead — same trust boundary OneCLI's own approval
 * proxy already uses on port 10255 (see config.ts's ONECLI_GATEWAY_URL
 * comment): reachable from any container on this host's default bridge
 * network, but not from the LAN or tailnet, since that network is host-local.
 *
 * Ask Docker directly (`docker network inspect bridge`) rather than reading
 * live OS interface state: `os.networkInterfaces()` OMITS docker0 entirely
 * whenever it has zero attached containers (NO-CARRIER on an empty bridge —
 * confirmed 2026-07-26, right after nanoclaw's own orphan-container cleanup
 * detaches the last veth on startup, before any new container reattaches
 * one). The bridge's assigned gateway IP doesn't depend on how many
 * containers are currently attached to it, so this stays correct through
 * that gap. Falls back to 127.0.0.1 (today's restrictive,
 * non-functional-for-containers default) only if Docker itself can't answer
 * — e.g. not installed — so we fail closed rather than widen exposure on an
 * unrecognized network layout.
 */
export async function getCredentialProxyHost(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'network',
      'inspect',
      'bridge',
      '--format',
      '{{(index .IPAM.Config 0).Gateway}}',
    ]);
    const ip = stdout.trim();
    if (ip) return ip;
  } catch (err) {
    log.warn(
      'Credential proxy: could not determine docker bridge gateway — falling back to 127.0.0.1 (unreachable from containers)',
      {
        err: (err as Error).message,
      },
    );
  }
  return '127.0.0.1';
}

export async function startCredentialProxy(port: number, host?: string): Promise<Server> {
  const resolvedHost = host ?? (await getCredentialProxyHost());
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  const upstreamUrl = new URL(secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          'content-length': body.length,
        };

        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) headers['authorization'] = `Bearer ${oauthToken}`;
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          log.error('Credential proxy upstream error', { err, url: req.url });
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, resolvedHost, () => {
      log.info('Credential proxy started', { port, host: resolvedHost, authMode });
      resolve(server);
    });

    server.on('error', reject);
  });
}

export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
