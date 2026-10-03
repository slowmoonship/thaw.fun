import { buildApp } from "./app.js";
await (await buildApp()).listen({ host: process.env.API_HOST ?? process.env.SHIPFUN_API_HOST ?? "127.0.0.1", port: Number(process.env.API_PORT ?? process.env.SHIPFUN_API_PORT ?? "3000") });
