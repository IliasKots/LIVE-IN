// Deployment environment is explicit: NODE_ENV=production also describes staging builds.
export function pointsMutationsAllowed(env = process.env) {
  return env.POINTS_ENABLED === 'true' && env.POINTS_MUTATIONS_ENABLED === 'true'
    && (['local', 'staging'].includes(env.POINTS_DEPLOYMENT_ENVIRONMENT)
      || (env.POINTS_DEPLOYMENT_ENVIRONMENT === 'production' && env.POINTS_PRODUCTION_ACCEPTED === 'true'));
}

export function pointsProductsVerified(env = process.env) {
  return env.ITCH_POINTS_PRODUCTS_VERIFIED === 'true';
}
