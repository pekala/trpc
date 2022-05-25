import { AnyRouter } from '@trpc/server';
import { TRPCResponse } from '@trpc/server/rpc';
import { TRPCClientError } from '../TRPCClientError';
import { TRPCAbortError } from '../internals/TRPCAbortError';
import { dataLoader } from '../internals/dataLoader';
import { httpRequest } from '../internals/httpRequest';
import { transformRPCResponse } from '../internals/transformRPCResponse';
import { HTTPLinkOptions, TRPCLink } from './core';

export interface HttpBatchLinkOptions extends HTTPLinkOptions {
  maxBatchSize?: number;
}

export function httpBatchLink<TRouter extends AnyRouter>(
  opts: HttpBatchLinkOptions,
): TRPCLink<TRouter> {
  const { url, maxBatchSize } = opts;
  // initialized config
  return (runtime) => {
    // initialized in app
    type Key = { id: number; path: string; input: unknown };

    const fetcher =
      (type: 'query' | 'mutation', method: 'query' | 'mutation') =>
      (keyInputPairs: Key[]) => {
        const path = keyInputPairs.map((op) => op.path).join(',');
        const inputs = keyInputPairs.map((op) => op.input);

        const { promise, cancel } = httpRequest({
          url,
          inputs,
          path,
          runtime,
          type,
          method,
        });

        return {
          promise: promise.then((res: unknown[] | unknown) => {
            if (!Array.isArray(res)) {
              return keyInputPairs.map(() => res);
            }
            return res;
          }),
          cancel,
        };
      };

    const loaders = {
      query: {
        query: dataLoader<Key, TRPCResponse>(fetcher('query', 'query'), {
          maxBatchSize,
        }),
        mutation: dataLoader<Key, TRPCResponse>(fetcher('query', 'mutation'), {
          maxBatchSize,
        }),
      },
      mutation: {
        query: dataLoader<Key, TRPCResponse>(fetcher('mutation', 'query'), {
          maxBatchSize,
        }),
        mutation: dataLoader<Key, TRPCResponse>(
          fetcher('mutation', 'mutation'),
          {
            maxBatchSize,
          },
        ),
      },
    };

    return ({ op, prev, onDestroy }) => {
      const { type, method } = op;
      if (type === 'subscription' || method === 'subscription') {
        throw new Error(
          'Subscriptions are not supported over HTTP, please add a Websocket link',
        );
      }
      const loader = loaders[type][method ?? type];
      const { promise, cancel } = loader.load(op);
      let isDone = false;
      const prevOnce: typeof prev = (result) => {
        if (isDone) {
          return;
        }
        isDone = true;
        prev(result);
      };
      onDestroy(() => {
        prevOnce(TRPCClientError.from(new TRPCAbortError(), { isDone: true }));
        cancel();
      });
      promise
        .then((envelope) => {
          prevOnce(transformRPCResponse({ envelope, runtime }));
        })
        .catch((cause) => {
          prevOnce(TRPCClientError.from<TRouter>(cause));
        });
    };
  };
}
