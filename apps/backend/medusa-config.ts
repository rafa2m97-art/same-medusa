import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    }
  },
  modules: [
    {
      resolve: "./src/modules/supplier",
    },
    {
      resolve: "./src/modules/pricing-rules",
    },
    {
      resolve: "./src/modules/warehouse-routing",
    },
    {
      resolve: "./src/modules/checkout-guards",
    },
    {
      resolve: "./src/modules/package-planning",
    },
    {
      resolve: "./src/modules/supplier-fulfillment",
    },
  ],
})
