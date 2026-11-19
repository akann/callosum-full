const env = process.env;

export const config = {
  databaseUrl: env.DATABASE_URL ?? 'postgres://callosum:callosum@localhost:54330/callosum',
  apiPort: Number(env.API_PORT ?? 3000),
  gatewayUrl: env.GATEWAY_URL ?? 'http://localhost:4001',
  meteringUrl: env.METERING_URL ?? 'http://localhost:4002',
};
