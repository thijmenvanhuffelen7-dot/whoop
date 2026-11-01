// Netlify Function: dezelfde proxy, met omgevingsvariabelen uit het Netlify-dashboard.
import { handle } from '../../server/whoop-proxy.mjs';

export default (request) => handle(request, {
  WHOOP_CLIENT_ID: process.env.WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET: process.env.WHOOP_CLIENT_SECRET,
  APP_URL: process.env.APP_URL || process.env.URL,
  REDIRECT_URI: process.env.REDIRECT_URI,
});

export const config = { path: '/api/whoop/*' };
