/* istanbul ignore file */

import http from 'http';
import ws from 'ws';
import {
  TRPCProcedureEnvelope,
  TRPCProcedureErrorEnvelope,
} from '../envelopes';
import { getErrorFromUnknown } from '../errors';
import { BaseOptions, CreateContextFn } from '../http';
import { getCombinedDataTransformer } from '../internals/getCombinedDataTransformer';
import { AnyRouter, ProcedureType } from '../router';
import { Subscription } from '../subscription';

// https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent
const WEBSOCKET_STATUS_CODES = {
  ABNORMAL_CLOSURE: 1006,
};

// json rpc 2 reference
// --> {"jsonrpc": "2.0", "method": "subtract", "params": [42, 23], "id": 1}
// <-- {"jsonrpc": "2.0", "result": 19, "id": 1}
// --> {"jsonrpc": "2.0", "method": "call", "params": [{type: x, 23]], "id": 1}

export type WSProcedureCall<TInput> = {
  path: string;
  input: TInput;
};

export type JSONRPC2ProcedureRequestEnvelope<TInput> = {
  id: number;
  jsonrpc: '2.0';
  method: ProcedureType;
  params: {
    input: TInput;
    path: string;
  };
};
export type JSONRPC2ProcedureStopEnvelope = {
  id: number;
  jsonrpc: '2.0';
  method: 'stop';
};
export type JSONRPC2RequestEnvelope<TInput = unknown> =
  | JSONRPC2ProcedureRequestEnvelope<TInput>
  | JSONRPC2ProcedureStopEnvelope;
export type JSONRPC2ResponseEnvelope<TResult = unknown> = {
  jsonrpc: '2.0';
  result: TResult;
  id: number;
};

function assertIsObject(obj: unknown): asserts obj is Record<string, unknown> {
  if (typeof obj !== 'object' || Array.isArray(obj) || !obj) {
    throw new Error('Not an object');
  }
}
function assertIsProcedureType(obj: unknown): asserts obj is ProcedureType {
  if (obj !== 'query' && obj !== 'subscription' && obj !== 'mutation') {
    throw new Error('Invalid procedure type');
  }
}
function assertIsRequestId(obj: unknown): asserts obj is number {
  if (typeof obj !== 'number' || isNaN(obj)) {
    throw new Error('Invalid requestId');
  }
}
function assertIsString(obj: unknown): asserts obj is string {
  if (typeof obj !== 'string') {
    throw new Error('Invalid string');
  }
}
function parseMessage(message: unknown) {
  assertIsString(message);
  const obj = JSON.parse(message);

  assertIsObject(obj);
  const { method, params, id } = obj;
  assertIsRequestId(id);
  if (method === 'stop') {
    return {
      type: 'stop' as const,
      id,
    };
  }
  assertIsProcedureType(method);
  assertIsObject(params);

  const { input, path } = params;
  assertIsString(path);
  return { type: method, id, input, path };
}

async function callProcedure<TRouter extends AnyRouter>(opts: {
  path: string;
  input: unknown;
  caller: ReturnType<TRouter['createCaller']>;
  type: ProcedureType;
}): Promise<unknown | Subscription<TRouter>> {
  const { type, path, input, caller } = opts;
  if (type === 'query') {
    return caller.query(path, input);
  }
  if (type === 'mutation') {
    return caller.mutation(path, input);
  }
  if (type === 'subscription') {
    const sub = (await caller.subscription(path, input)) as Subscription;
    return sub;
  }

  throw new Error(`Unknown procedure type ${type}`);
}

/**
 * Web socket server handler
 */
export type WSSHandler<TRouter extends AnyRouter> = {
  router: TRouter;
  wss: ws.Server;
  createContext: CreateContextFn<TRouter, http.IncomingMessage, ws>;
} & BaseOptions<TRouter, http.IncomingMessage>;

export function wssHandler<TRouter extends AnyRouter>(
  opts: WSSHandler<TRouter>,
) {
  const { router, wss, createContext } = opts;
  const transformer = getCombinedDataTransformer(opts.transformer);
  wss.on('connection', async (client, req) => {
    const clientSubscriptions = new Map<number, Subscription<TRouter>>();

    try {
      const ctx = await createContext({ req, res: client });
      const caller = router.createCaller(ctx);
      client.on('message', async (message) => {
        client.on('close', () => {
          for (const sub of clientSubscriptions.values()) {
            sub.destroy();
          }
          clientSubscriptions.clear();
        });
        function respond(
          id: number,
          json: TRPCProcedureEnvelope<TRouter, unknown>,
        ) {
          const response: JSONRPC2ResponseEnvelope<typeof json> = {
            jsonrpc: '2.0',
            result: transformer.output.serialize(json),
            id,
          };
          client.send(JSON.stringify(response));
        }
        const info = parseMessage(message);
        const input =
          typeof info.input !== 'undefined'
            ? transformer.input.deserialize(info.input)
            : undefined;

        if (info.type === 'stop') {
          clientSubscriptions.get(info.id)?.destroy();
          clientSubscriptions.delete(info.id);
          return;
        }
        const { path, type, id } = info;
        try {
          const result = await callProcedure({ path, input, type, caller });

          if (result instanceof Subscription) {
            const sub = result;
            if (client.readyState !== client.OPEN) {
              sub.destroy();
              return;
            }

            if (clientSubscriptions.has(id)) {
              sub.destroy();
              throw new Error(`Duplicate id ${id}`);
            }
            clientSubscriptions.set(id, sub);
            sub.on('data', (data: unknown) => {
              respond(id, {
                ok: true,
                data,
              });
            });
            sub.on('error', (_error: unknown) => {
              const error = getErrorFromUnknown(_error);
              const json: TRPCProcedureErrorEnvelope<TRouter> = {
                ok: false,
                error: router.getErrorShape({
                  error,
                  type: 'subscription',
                  path,
                  input,
                  ctx,
                }),
              };
              // TODO trigger some global error handler?
              respond(id, json);
            });
            await sub.start();
            // FIXME handle errors? or not? maybe push it to a callback with the ws client
            return;
          }
          respond(id, {
            ok: true,
            data: result,
          });
        } catch (error) {
          const json: TRPCProcedureErrorEnvelope<TRouter> = {
            ok: false,
            error: router.getErrorShape({
              error,
              type: 'unknown',
              path: undefined,
              input: undefined,
              ctx,
            }),
          };
          // TODO trigger some global error handler?
          respond(id, json);
        }
      });
    } catch (err) {
      const error = getErrorFromUnknown(err);

      const json: TRPCProcedureErrorEnvelope<TRouter> = {
        ok: false,
        error: router.getErrorShape({
          error,
          type: 'unknown',
          path: undefined,
          input: undefined,
          ctx: undefined,
        }),
      };
      client.send(json);
      client.close(WEBSOCKET_STATUS_CODES.ABNORMAL_CLOSURE);
    }
  });
}
