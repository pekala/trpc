import { TRPCResponse } from '@trpc/server/rpc';
import { LinkRuntimeOptions, PromiseAndCancel } from '../links/core';

// https://github.com/trpc/trpc/pull/669
function arrayToDict(array: unknown[]) {
  const dict: Record<number, unknown> = {};
  for (let index = 0; index < array.length; index++) {
    const element = array[index];
    dict[index] = element;
  }
  return dict;
}

export function httpRequest<TResponseShape = TRPCResponse>(
  props: {
    runtime: LinkRuntimeOptions;
    type: 'query' | 'mutation';
    method: 'query' | 'mutation';
    path: string;
    url: string;
  } & ({ inputs: unknown[] } | { input: unknown }),
): PromiseAndCancel<TResponseShape> {
  const { type, method, runtime: rt, path } = props;
  const ac = rt.AbortController ? new rt.AbortController() : null;
  const httpMethods = {
    query: 'GET',
    mutation: 'POST',
  };
  const input =
    'input' in props
      ? rt.transformer.serialize(props.input)
      : arrayToDict(
          props.inputs.map((_input) => rt.transformer.serialize(_input)),
        );

  function getUrl() {
    let url = props.url + '/' + path;
    const queryParts: string[] = [];
    if (type !== method) {
      queryParts.push(`type=${type}`);
    }
    if ('inputs' in props) {
      queryParts.push('batch=1');
    }
    if (method === 'query' && input !== undefined) {
      queryParts.push(`input=${encodeURIComponent(JSON.stringify(input))}`);
    }
    if (queryParts.length) {
      url += '?' + queryParts.join('&');
    }
    return url;
  }
  function getBody() {
    if (method === 'query') {
      return undefined;
    }
    return input !== undefined ? JSON.stringify(input) : undefined;
  }

  const promise = new Promise<TResponseShape>((resolve, reject) => {
    const url = getUrl();

    Promise.resolve(rt.headers())
      .then((rawHeaders) => {
        const headers: HeadersInit = { 'content-type': 'application/json' };
        for (const key in rawHeaders) {
          const header = rawHeaders[key];
          if (header !== undefined) {
            if (Array.isArray(header)) {
              headers[key] = header.join(',');
            } else {
              headers[key] = header;
            }
          }
        }

        return rt.fetch(url, {
          method: httpMethods[method],
          signal: ac?.signal,
          body: getBody(),
          headers,
        });
      })
      .then((res) => {
        return res.json();
      })
      .then((json) => {
        resolve(json);
      })
      .catch(reject);
  });
  const cancel = () => {
    ac?.abort();
  };
  return { promise, cancel };
}
