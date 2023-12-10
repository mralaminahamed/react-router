import * as React from "react";
import { ResultType, UNSAFE_ErrorResponseImpl } from "react-router-dom";
import {
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
} from "react-router-dom/server.js";
import { encode } from "turbo-stream";

import { globRoutes } from "./glob-routes.js";
import { renderToReadableStream } from "./render-to-readable-stream.node.js";

const routes = globRoutes(import.meta.glob("./routes/**/route.tsx"));

export async function render(
  request: Request,
  {
    bootstrapModules,
    bootstrapScriptContent,
  }: { bootstrapModules?: string[]; bootstrapScriptContent?: string }
) {
  let url = new URL(request.url);
  let isDataRequest = url.pathname.endsWith(".data");
  let xRouteIds = request.headers.get("X-Routes")?.split(",");

  if (isDataRequest) {
    request = new Request(
      new URL(url.pathname.replace(/\.data$/, "") + url.search, url),
      {
        body: request.body,
        headers: request.headers,
        method: request.method,
        signal: request.signal,
      }
    );
  }

  let { query, dataRoutes } = createStaticHandler(routes, {
    async dataStrategy({ defaultStrategy, matches }) {
      if (isDataRequest && xRouteIds?.length) {
        let routesToLoad = new Set(xRouteIds);

        return Promise.all(
          matches.map((match) => {
            if (!routesToLoad!.has(match.route.id)) {
              return {
                type: ResultType.data,
                data: undefined,
              };
            }

            return defaultStrategy(match);
          })
        );
      }

      return Promise.all(
        matches.map((match) => {
          return defaultStrategy(match);
        })
      );
    },
  });

  let context = await query(request);

  if (context instanceof Response) {
    return context;
  }

  if (isDataRequest) {
    return new Response(
      encode({
        actionData: context.actionData,
        loaderData: context.loaderData,
      }),
      {
        status: context.statusCode,
        headers: {
          "Content-Type": "text/turbo-stream; charset=utf-8",
          "Transfer-Encoding": "chunked",
          Vary: "X-Routes",
        },
      }
    );
  }

  let router = createStaticRouter(dataRoutes, context);

  let body = await renderToReadableStream(
    <React.StrictMode>
      <StaticRouterProvider
        router={router}
        context={context}
        nonce="the-nonce"
      />
    </React.StrictMode>,
    {
      onError: console.error,
      bootstrapModules,
      bootstrapScriptContent,
      signal: request.signal,
    }
  );

  // TODO: handle headers

  return new Response(body, {
    status: context.statusCode,
    headers: {
      "Content-Type": "text/html",
      "Transfer-Encoding": "chunked",
    },
  });
}